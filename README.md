# Shopify QA Agent

Automatically tests a Shopify store and produces a professional QA report. No technical knowledge required to run it.

---

## What It Does

You give it a Shopify store domain and API token. It does the rest:

- Tests security, performance, accessibility, SEO
- Walks through the checkout flow like a real customer
- Checks the site on mobile and desktop
- Reads the theme code and verifies features work on the live site
- Produces a written report and a PDF ready to send to a client

---

## Before You Start (One-Time Setup)

You need four things installed on your computer. If they are already installed, skip to **Running the Agent**.

### 1. Node.js
Download and install from: **https://nodejs.org** (click the green "LTS" button)

### 2. Claude Code
Download and install from: **https://claude.ai/claude-code**

Sign in with your Kilowott email when prompted.

### 3. GitHub CLI
Download and install from: **https://cli.github.com**

After installing, open PowerShell and run:
```
gh auth login
```
Follow the prompts to sign in with your GitHub account.

### 4. Install the agent dependencies
Open PowerShell, navigate to the agent folder, and run:
```
cd C:\Users\Kilowott\Desktop\shopify-qa-agent
npm install
npm run build
```

You only need to do this once.

---

## Running the Agent

### Step 1 — Open PowerShell in the agent folder

```
cd C:\Users\Kilowott\Desktop\shopify-qa-agent
claude
```

### Step 2 — Type the command

```
/shopify-qa yourstore.myshopify.com
```

Replace `yourstore.myshopify.com` with the actual store domain.

### Step 3 — Enter credentials (first time only)

If this is the first time running on this store, Claude will ask for:

**1. Admin API Token**
- Go to the Shopify Admin for the store
- Click **Apps and sales channels** (left menu)
- Click **Develop apps** (top right button)
- Open your app (or create one)
- Click the **API credentials** tab
- Copy the **Admin API access token** (starts with `shpat_`)

**2. Storefront Password** (only if the store is password-protected)
- This is the password customers need to enter to view the store
- Leave blank and press Enter if the store is public

**3. GitHub Theme Repo URL** (optional)
- Example: `https://github.com/Kilowott-HQ/Vingtor`
- Leave blank and press Enter if you don't have one
- Providing this allows deeper code analysis

The agent saves these credentials automatically. Next time you run the same store, it skips straight to testing.

### Step 4 — Wait for it to finish

The agent runs in two stages:

| Stage | What it does | Time |
|-------|-------------|------|
| Layer 1 | Automated checks (security, SEO, performance, etc.) | 3–5 minutes |
| Layer 2 | AI browser testing (checkout, visual, mobile, forms) | 20–30 minutes |

You will see progress in the terminal. Do not close it while it is running.

### Step 5 — Find your reports

When finished, reports are saved in:
```
qa-reports/yourstore.myshopify.com-[today's date]/
```

| File | What it is |
|------|-----------|
| `final-report.pdf` | Professional PDF — send this to the client |
| `final-report.md` | Same report as a text file |
| `screenshots/` | Folder of screenshots taken during testing |

---

## Running Again After Fixes

Once the client has fixed the issues, run the agent again:

```
/shopify-qa yourstore.myshopify.com
```

It will automatically compare against the previous run and show:
- Which issues were fixed
- Which issues are new
- Which issues got worse

Each run creates a new date-stamped folder so old reports are never lost.

---

## Running on a Different Store

```
/shopify-qa newstore.myshopify.com
```

Claude will ask for the new store's credentials, save them, and run the full audit.

Each store gets its own saved config file so you can switch between stores easily.

---

## Troubleshooting

**"command not found: claude"**
Claude Code is not installed. Download it from https://claude.ai/claude-code

**"Cannot connect to Admin API: 401"**
Your API token is wrong or expired. Go back to Shopify Admin → Apps → Develop apps and copy a fresh token.

**"gh: command not found"**
GitHub CLI is not installed. Download it from https://cli.github.com

**The agent stops halfway through**
Your Claude session hit its token limit. Wait until it resets (check the time shown in the terminal) and run the command again.

**"Must be a Shopify domain (e.g., mystore.myshopify.com)"**
Use the `.myshopify.com` domain, not the custom domain.
- ✅ `yourstore.myshopify.com`
- ❌ `yourstore.com`

---

## Questions?

Contact the development team at Kilowott.
