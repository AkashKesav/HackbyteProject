/**
 * DEMO MODULE - Tagging Mix Test
 * 
 * A collection of utility functions for user profile handling,
 * input normalization, risk assessment, and audit reporting.
 */

// Build a formatted human-readable profile summary from user object
function buildProfileSummary(user) {
  const joinDate = user.createdAt || 'Unknown';
  const status = user.isActive ? 'ACTIVE' : 'INACTIVE';
  
  return [
    `User Profile Summary`,
    `────────────────────`,
    `Name: ${user.name || 'N/A'}`,
    `Email: ${user.email || 'N/A'}`,
    `Role: ${user.role || 'USER'}`,
    `Status: ${status}`,
    `Joined: ${joinDate}`,
    `Last Active: ${user.lastLogin || 'Never'}`,
  ].join('\n');
}

// Normalize user input by trimming, lowercasing, and sanitizing special cases
function normalizeUserInput(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }
  
  const normalized = {};
  
  if (input.username) {
    normalized.username = input.username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }
  if (input.email) {
    normalized.email = input.email.trim().toLowerCase();
  }
  if (input.comment) {
    normalized.comment = input.comment.trim().substring(0, 500);
  }
  if (input.tags && Array.isArray(input.tags)) {
    normalized.tags = input.tags.map(tag => tag.trim().toLowerCase());
  }
  
  return normalized;
}

// Calculate a risk score based on event history analysis
function calculateRiskScore(events) {
  let score = 0;
  
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }
  
  for (const event of events) {
    if (event.type === 'failed_login') {
      score += 5;
    } else if (event.type === 'suspicious_query') {
      score += 10;
    } else if (event.type === 'privilege_escalation_attempt') {
      score += 25;
    } else if (event.type === 'data_export') {
      score += 8;
    } else if (event.type === 'password_change') {
      score -= 2;
    }
    
    if (event.timestamp) {
      const hoursSinceEvent = (Date.now() - new Date(event.timestamp)) / (1000 * 60 * 60);
      if (hoursSinceEvent < 24) {
        score += 3;
      }
    }
  }
  
  return Math.min(score, 100);
}

// Render an audit log entry as an HTML table row
function renderAuditRow(entry) {
  const timestamp = entry.timestamp || new Date().toISOString();
  const user = entry.user || 'system';
  const action = entry.action || 'UNKNOWN';
  const status = entry.status || 'pending';
  
  const statusClass = status === 'success' ? 'status-success' : 
                      status === 'failed' ? 'status-failed' : 'status-pending';
  
  return `<tr>
    <td>${timestamp}</td>
    <td>${user}</td>
    <td>${action}</td>
    <td class="${statusClass}">${status}</td>
    <td>${entry.details || '-'}</td>
  </tr>`;
}

module.exports = {
  buildProfileSummary,
  normalizeUserInput,
  calculateRiskScore,
  renderAuditRow,
};


//hey there
//this is a test file 
//guess what is this for
