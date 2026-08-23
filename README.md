# YNAB Cumulative Trends

## Problem

Zero-based budgeting accounts for every dollar, but that means investments and savings often flow into a "spend" category too, obscuring your real savings rate. Without cumulative trends, it's hard to see how spending in a category builds over the year until it's already a problem.

## Solution

I wrote a script that adds cumulative **Income vs. Spend** and **Category Trends** above YNAB's native monthly bar chart, run on demand from a browser bookmarklet rather than installed as an extension. These visuals show how income and spending trends build through the year, making trends easier to identify. The category trend was motivated by my desire to watch lifestyle creep in key categories, such as spending on eating out and personal services.

> All figures in the screenshots below are fabricated sample data for illustration purposes.

## Screenshots

<table>
<tr>
<td width="50%">

**Income vs. Spend**

![Income vs. Spend chart, cumulative lines for income and spend over the year](screenshots/income-vs-spend.png)

</td>
<td width="50%">

**Category Trends**

![Category Trends chart, cumulative lines for Enjoyment, Wellness, and Subscriptions](screenshots/category-trends.png)

</td>
<td width="50%"></td>
</tr>
</table>

## Features

- **Cumulative, not monthly.** Both charts run a year-to-date total rather than resetting each month, so trend direction and category creep are obvious at a glance.
- **Category picker.** A dropdown styled after YNAB's own "All Categories" selector lets you choose exactly which categories count toward Spend, and which category groups get their own line on Category Trends — each with its own color, search box, and Select All/None.
- **Year selector.** Switch between any year present in your budget. The current year projects the remaining months at your actual average pace (shown as a dashed line); past years show actual months only.
- **Hover tooltips** with the exact income, spend, and net for any month.
- **No server, no build step.** A single self-contained script — JavaScript and inline SVG, no charting library or backend.
- **Dynamic budget detection.** The script reads your budget ID straight from the URL (e.g. `https://app.ynab.com/<BUDGET_ID>/reflect/spending-trends`), so it works for any budget with no configuration.
- **Secure token storage.** Your token is stored in this browser's localStorage, never written into the script file itself.
- **No extension required.** Runs as a bookmarklet that loads the current script straight from this repo — nothing to install or keep updated.

## Setup

1. In YNAB, go to **Account Settings → Developer Settings → New Token** and copy it. You won't need to save it anywhere else — it goes straight into the one-time prompt in step 4.
2. Create a new bookmark (any name works, e.g. "YNAB Cumulative Trends") and paste this in as its URL:

   ```
   javascript:(function(){var d=document,s=d.createElement('script');s.src='https://cdn.jsdelivr.net/gh/BotanicalAmy/ynab-cumulative-trends@main/CumulativeTrends.js?t='+Date.now();s.onerror=function(){alert('YNAB Cumulative Trends: failed to load. Check the browser console for a Content-Security-Policy error.');};d.head.appendChild(s);})();
   ```

   In Chrome: right-click the bookmarks bar → **Add page...** → paste the code above into the URL field. (GitHub strips `javascript:` links from rendered READMEs, so a draggable bookmarklet link won't work here — copying the code into a bookmark's URL field always does.)
3. Open a YNAB Spending Trends page — `https://app.ynab.com/<BUDGET_ID>/reflect/spending-trends` — and click the bookmark. The script only runs on this page.
4. The first time it runs, you'll get a one-time browser prompt for the token from step 1.
5. The native chart is replaced with Income vs. Spend and Category Trends (if the native chart can't be found, these are added above it instead). Category Trends defaults to Enjoyment/Wellness/Subscriptions — change the defaults by editing `CONFIG.DEFAULT_CATEGORY_TRENDS_GROUPS` near the top of the file, or use the picker on the chart itself (your picks persist until you reload the page).
6. Since nothing stays installed, click the bookmark again on any later visit — including after a page reload or in a new tab.

To change or clear the stored token, use the small **Reset YNAB API Token** link the panel adds. A rejected token (for example, after rotating it in YNAB) is also cleared automatically, and you'll be re-prompted immediately.

> **Note:** unlike a Tampermonkey script, a bookmarklet has to load through the page's own security policy rather than bypassing it. If YNAB's policy ever blocks it, you'd see a Content-Security-Policy error in the browser console (and the alert above would fire). If that happens, the fix is either to package this as a small personal browser extension instead, or fall back to running it through Tampermonkey.

## How it works

The script calls YNAB's public [API](https://api.ynab.com/) directly from your browser, so there's no server involved. Clicking the bookmarklet loads the current version of `CumulativeTrends.js` straight from this GitHub repo, then fetches your budget once per year you select and does all the cumulative math and chart rendering client-side. Your token stays in this browser's localStorage.

## Disclaimer

This is an independent, unofficial project and is not affiliated with or endorsed by YNAB. It uses YNAB's published API to read your budget data and never modifies it.

## License

[MIT](LICENSE)
