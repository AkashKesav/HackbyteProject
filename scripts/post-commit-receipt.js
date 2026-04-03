const { execFileSync } = require("node:child_process");

const backendUrl = process.env.COMMIT_CONFESSIONAL_RECEIPT_URL || "http://127.0.0.1:4000/api/receipt";

function main() {
  const commitHash = execGit(["rev-parse", "HEAD"]).trim();
  const diffText = execGit(["show", "--format=", "--unified=0", commitHash]);

  const payload = {
    commitHash,
    diffText,
  };

  fetch(backendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.message || `Receipt request failed with ${response.status}`);
      }

      const evidence = body.modelEvidence || {};
      const contribution = evidence.contribution || {};
      const copilotContribution = body.copilotContribution || evidence.copilotContribution || {};
      console.log(
        `Commit Confessional receipt: certainty=${evidence.certainty || "NONE"} model=${evidence.model || "unknown"} method=${evidence.method || "none"}`
      );
      console.log(
        `Copilot contribution: matched=${copilotContribution.aiMatchedLines || 0}/${copilotContribution.totalChangedLines || 0} percentage=${copilotContribution.estimatedAiPercentage || 0}% confidence=${copilotContribution.confidenceLevel || "LOW"} events=${copilotContribution.eventCount || 0}`
      );
      if (copilotContribution.sampleTooSmall) {
        console.log("Copilot contribution sample is too small for a stable percentage.");
      }
      console.log(
        `AI contribution: matched=${contribution.aiMatchedLines || 0}/${contribution.totalChangedLines || 0} percentage=${contribution.estimatedAiPercentage || 0}% confidence=${contribution.confidenceLevel || "LOW"}`
      );
      if (contribution.sampleTooSmall) {
        console.log("AI contribution sample is too small for a stable percentage.");
      }
      if (Array.isArray(evidence.evidence) && evidence.evidence.length) {
        for (const line of evidence.evidence) {
          console.log(`- ${line}`);
        }
      }
      if (Array.isArray(contribution.matchedLineSamples) && contribution.matchedLineSamples.length) {
        console.log("Matched line samples:");
        for (const line of contribution.matchedLineSamples) {
          console.log(`  ${line}`);
        }
      }
      if (body.receiptUrl) {
        console.log(`receiptUrl=${body.receiptUrl}`);
      }
    })
    .catch((error) => {
      console.error(`Commit Confessional receipt failed: ${error.message}`);
      process.exitCode = 1;
    });
}

function execGit(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

main();
