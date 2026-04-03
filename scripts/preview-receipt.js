const { execFileSync } = require("node:child_process");

const backendUrl = process.env.COMMIT_CONFESSIONAL_RECEIPT_URL || "http://127.0.0.1:4000/api/receipt";

async function main() {
  const stagedDiff = execGit(["diff", "--cached", "--unified=0"]);
  const workingDiff = execGit(["diff", "--unified=0"]);
  const diffText = [stagedDiff, workingDiff].filter(Boolean).join("\n");

  if (!diffText.trim()) {
    console.log("No staged or working-tree diff found.");
    return;
  }

  const payload = {
    diffText,
    receiptUrl: "preview://working-tree",
  };

  try {
    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.message || `Receipt request failed with ${response.status}`);
    }

    const evidence = body.modelEvidence || {};
    const contribution = evidence.contribution || {};
    const copilotContribution = body.copilotContribution || evidence.copilotContribution || {};

    console.log(
      `Preview receipt: certainty=${evidence.certainty || "NONE"} model=${evidence.model || "unknown"} method=${evidence.method || "none"}`
    );
    console.log(
      `Copilot contribution: matched=${copilotContribution.aiMatchedLines || 0}/${copilotContribution.totalChangedLines || 0} percentage=${copilotContribution.estimatedAiPercentage || 0}% confidence=${copilotContribution.confidenceLevel || "LOW"} events=${copilotContribution.eventCount || 0}`
    );
    console.log(
      `AI contribution: matched=${contribution.aiMatchedLines || 0}/${contribution.totalChangedLines || 0} percentage=${contribution.estimatedAiPercentage || 0}% confidence=${contribution.confidenceLevel || "LOW"}`
    );

    if (Array.isArray(evidence.evidence) && evidence.evidence.length) {
      for (const line of evidence.evidence) {
        console.log(`- ${line}`);
      }
    }
  } catch (error) {
    console.error(`Preview receipt failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function execGit(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

main();
