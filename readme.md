# 🚀 CodeTruth – AI Code Provenance Tracker

## 🧠 Overview

CodeTruth is a developer tool that tracks, tags, and estimates AI-generated code contribution in a project. Instead of trying to detect AI-written code after the fact, CodeTruth captures AI usage **at the source** (copy/paste events) and maps it to Git commits.

---

## 🔥 Features

* 📋 Detects copy events from AI tools (ChatGPT, Claude, Gemini)
* 📌 Tracks paste events into the codebase
* 🔗 Maps AI-generated content to Git commits
* 📊 Calculates approximate AI vs Human contribution (%)
* 🧾 Adds AI metadata to commit messages
* 📈 Simple dashboard for visualization

---

## 🏗️ Architecture

### 1. Browser Extension

* Detects copy events from AI platforms
* Captures copied content, source, and timestamp
* Sends data to backend

### 2. Backend (Node.js + Express)

* Stores AI interaction logs
* Matches pasted code with stored AI content
* Computes contribution metrics

### 3. Git Hook Integration

* Runs on `pre-commit`
* Analyzes staged changes using `git diff --cached`
* Calculates AI contribution percentage
* Appends metadata to commit message

### 4. Dashboard

* Displays:

  * AI vs Human %
  * Model usage
  * Timeline of AI-assisted commits

---

## ⚙️ How It Works

1. User copies code from an AI tool
2. Extension logs the event
3. User pastes code into project
4. On commit:

   * Diff is analyzed
   * Lines are compared with AI logs
   * % is calculated
5. Commit message updated:

```bash
git commit -m "Add login API [AI: ChatGPT ~65%]"
```

---

## 📊 AI Contribution Calculation

### Method: Diff-based Approximation

```
AI % = (AI-matched lines / total added lines) * 100
```

### Notes

* Uses string similarity matching
* Provides approximate (not exact) values
* Can be extended with advanced ML models

---

## 🛠️ Tech Stack

* Backend: Node.js, Express
* Database: MongoDB
* Extension: JavaScript (Chrome/Firefox APIs)
* Git Hooks: Shell + Node.js
* Frontend: React / HTML

---

## 🚀 Getting Started

### 1. Clone Repo

```bash
git clone https://github.com/your-username/codetruth.git
cd codetruth
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Run Backend

```bash
npm start
```

### 4. Load Extension

* Open browser extensions
* Enable Developer Mode
* Load unpacked extension

### 5. Setup Git Hook

```bash
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

---

## ⚠️ Limitations

* Cannot detect AI code written manually
* Users can modify AI code after pasting
* Percentage is an approximation, not exact

---

## 💡 Future Improvements

* VS Code extension for better tracking
* ML-based similarity detection
* Blockchain-based tamper-proof logs
* Multi-repo analytics dashboard

---

## 🏆 Hackathon Pitch

> "We don’t detect AI code — we prove where it came from."

---

## 📜 License

MIT License
