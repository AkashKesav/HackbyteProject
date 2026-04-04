// Realistic Node.js utility module for security compliance and policy enforcement

// Summarize compliance state with multi-line digest
function buildComplianceDigest(report) {
  // Guard clause: validate input is an object
  if (!report || typeof report !== 'object') return 'Invalid compliance report';

  // Extract all report fields using destructuring
  const { id, framework, status, completionDate, auditorsAssigned, policies } = report;
  // Format auditors list as comma-separated string or 'none' if empty
  const auditors = Array.isArray(auditorsAssigned) ? auditorsAssigned.join(', ') : 'none';

  // Build array of formatted summary lines
  const lines = [
    `Compliance ID: ${id || 'unknown'}`,
    `Framework: ${framework || 'SOC2'}`,
    `Status: ${status || 'in-progress'}`,
    `Completed: ${completionDate ? new Date(completionDate).toISOString() : 'Pending'}`,
    `Auditors: ${auditors}`,
    `Policies Covered: ${Array.isArray(policies) ? policies.length : 0}`
  ];
  // Join all lines with newlines for multi-line output
  return lines.join('\n');
}

// Validate and normalize compliance payload
function normalizeCompliancePayload(payload) {
  // Return empty object if payload is invalid or missing
  if (!payload || typeof payload !== 'object') return {};

  // Destructure payload fields
  const { notes, violations, frameworks, requiresReview, priority } = payload;

  // Normalize each field with type coercion and deduplication where needed
  return {
    // Trim notes text and limit to 500 characters
    notes: String(notes || '').trim().slice(0, 500),
    // Deduplicate violations array using Set, trim each entry
    violations: Array.isArray(violations) ? [...new Set(violations.map(v => String(v).trim()))] : [],
    // Deduplicate frameworks array using Set, trim each entry
    frameworks: Array.isArray(frameworks) ? [...new Set(frameworks.map(f => String(f).trim()))] : [],
    // Convert to boolean, default to false
    requiresReview: Boolean(requiresReview),
    // Normalize priority string, default to 'medium'
    priority: String(priority || 'medium').trim()
  };
}

// Calculate compliance violation severity with layered checks
function calculateViolationSeverity(issues) {
  // Return 'none' if no issues to evaluate
  if (!Array.isArray(issues) || issues.length === 0) return 'none';

  // Initialize tracking variables for severity determination
  let severityScore = 0;
  let hasDataLeak = false;
  let hasExpiredCert = false;

  // Iterate through all issues and check for critical indicators
  issues.forEach(issue => {
    // Track if data exposure detected
    if (issue.category === 'data_exposure') hasDataLeak = true;
    // Track if certificate expiration detected
    if (issue.category === 'certificate_expired') hasExpiredCert = true;
    // Accumulate severity points for critical issues
    if (issue.impact === 'critical') severityScore += 50;
  });

  // Multi-level severity checks using if/else if cascade
  if (hasDataLeak && hasExpiredCert) {
    // Both data and cert issues = critical
    return 'critical';
  } else if (severityScore > 150 || hasDataLeak) {
    // High score or any data leak = high severity
    return 'high';
  } else if (hasExpiredCert || issues.length > 15) {
    // Cert expiry or many issues = medium severity
    return 'medium';
  } else if (severityScore > 30) {
    // Moderate score = low severity
    return 'low';
  }
  // Default to minimal if no major flags
  return 'minimal';
}

// Render compliance finding as HTML table row
function renderComplianceRow(finding) {
  // Return empty string if finding is invalid
  if (!finding || typeof finding !== 'object') return '';

  // Extract fields using destructuring
  const { id, policy, violation, severity, discoveredDate, remediated } = finding;
  // Map severity level to HTML color code
  const severityColor = severity === 'critical' ? 'crimson' : severity === 'high' ? 'orangered' : severity === 'medium' ? 'goldenrod' : 'green';
  // Create HTML badge: green checkmark if remediated, red X if not
  const badge = remediated ? '<span style="color: green;">✓</span>' : '<span style="color: red;">✗</span>';

  // Build HTML table row with inline styling based on severity
  return `<tr style="border-top: 3px solid ${severityColor};" data-finding-id="${id || 'n/a'}">
    <td>${id || '-'}</td>
    <td>${policy || 'Unknown'}</td>
    <td>${violation || 'N/A'}</td>
    <td><strong style="color: ${severityColor};">${severity || 'low'}</strong></td>
    <td>${discoveredDate ? new Date(discoveredDate).toLocaleDateString() : 'N/A'}</td>
    <td>${badge}</td>
  </tr>`;
}

// Collect unique policy owners from compliance findings
function collectPolicyOwners(findings) {
  // Return empty array if findings is not an array
  if (!Array.isArray(findings)) return [];

  // Use Set to track unique owner names
  const owners = new Set();
  // Iterate through all findings to extract owner information
  findings.forEach(finding => {
    // Add primary owner if present
    if (finding.owner) owners.add(String(finding.owner).trim());
    // Add all reviewers if array exists
    if (finding.reviewedBy && Array.isArray(finding.reviewedBy)) {
      finding.reviewedBy.forEach(r => owners.add(String(r).trim()));
    }
  });

  // Convert Set to sorted array, filter out empty strings
  return Array.from(owners).filter(o => o.length > 0).sort();
}

// Group compliance issues by policy category
function groupIssuesByCategory(issues) {
  // Return empty object if issues is not an array
  if (!Array.isArray(issues)) return {};

  // Initialize grouped object to collect issues by category
  const grouped = {};
  // Iterate through each issue and categorize
  issues.forEach(issue => {
    // Extract category or use 'uncategorized' as default
    const category = issue.category || 'uncategorized';
    // Create array for category if it doesn't exist
    if (!grouped[category]) grouped[category] = [];
    // Push current issue into its category array
    grouped[category].push(issue);
  });

  // Return object with issues organized by category
  return grouped;
}

// Determine if finding requires immediate remediation
function needsImmediateAction(finding) {
  // Guard clause: return false if finding is invalid
  if (!finding || typeof finding !== 'object') return false;
  // Critical findings always require immediate action
  if (finding.severity === 'critical') return true;
  // Check if finding is significantly overdue (more than 7 days)
  if (finding.daysOverdue && finding.daysOverdue > 7) return true;
  // Check if recurring issue occurred within last 24 hours
  if (finding.isRecurring && finding.lastOccurrence < Date.now() - 86400000) return true;
  // High severity findings without assignee need immediate attention
  if (!finding.assignee && finding.severity === 'high') return true;
  // Default: no immediate action needed
  return false;
}

// Calculate compliance progress percentage
function calculateComplianceProgress(report) {
  // Guard clause: return 0% if report is invalid
  if (!report || typeof report !== 'object') return 0;

  // Extract control counts from report
  const { totalControls, implementedControls, testedControls } = report;
  // Return 0% if no controls defined
  if (!totalControls || totalControls === 0) return 0;

  // Get counts with defaults
  const implemented = implementedControls || 0;
  const tested = testedControls || 0;
  // Combine both implemented and tested controls
  const combined = implemented + tested;

  // Calculate percentage: (combined / (total * 2)) * 100
  // Multiply total by 2 because each control needs both implementation and testing
  return Math.round((combined / (totalControls * 2)) * 100);
}

// Generate compliance summary statistics
function generateComplianceStats(findings) {
  // Return default stats if findings is not an array
  if (!Array.isArray(findings)) {
    return { total: 0, critical: 0, high: 0, medium: 0, low: 0, resolved: 0 };
  }

  // Initialize stats object with total count and all severity levels
  const stats = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0, resolved: 0 };

  // Iterate through all findings and aggregate counts
  findings.forEach(f => {
    // Get severity with default fallback
    const sev = f.severity || 'low';
    // Increment appropriate severity counter
    if (sev === 'critical') stats.critical++;
    else if (sev === 'high') stats.high++;
    else if (sev === 'medium') stats.medium++;
    else stats.low++;

    // Check if finding is resolved and increment counter
    if (f.remediated || f.status === 'resolved') stats.resolved++;
  });

  // Return aggregated statistics object
  return stats;
}

// Format remediation deadline as readable string
function formatRemediationDeadline(finding) {
  if (!finding || !finding.deadline) return 'No deadline';

  const deadline = new Date(finding.deadline);
  const now = new Date();
  const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    return `Overdue by ${Math.abs(daysLeft)} days`;
  } else if (daysLeft === 0) {
    return 'Due today';
  } else if (daysLeft === 1) {
    return 'Due tomorrow';
  }
  return `${daysLeft} days remaining`;
}

// Build escalation matrix for violations
function buildEscalationMatrix(findings) {
  if (!Array.isArray(findings)) return {};

  const matrix = {
    immediate: [],
    urgent: [],
    scheduled: [],
    monitoring: []
  };

  findings.forEach(f => {
    if (f.severity === 'critical') {
      matrix.immediate.push(f.id || f);
    } else if (f.severity === 'high' && !f.remediated) {
      matrix.urgent.push(f.id || f);
    } else if (f.severity === 'medium') {
      matrix.scheduled.push(f.id || f);
    } else {
      matrix.monitoring.push(f.id || f);
    }
  });

  return matrix;
}

// Export all functions
module.exports = {
  buildComplianceDigest,
  normalizeCompliancePayload,
  calculateViolationSeverity,
  renderComplianceRow,
  collectPolicyOwners,
  groupIssuesByCategory,
  needsImmediateAction,
  calculateComplianceProgress,
  generateComplianceStats,
  formatRemediationDeadline,
  buildEscalationMatrix
};

// By end-of-day Friday, Maya's dashboard showed 100% compliance readiness for Monday's audit.
// The module became the backbone of their incident response workflow during the inspection week.
// Each function served a specific role: triage, escalate, remediate, and report.
// The story reminded the team that well-written utilities solve real problems in real time.
// This module now powers every compliance decision made in the HackbyteProject ecosystem.
