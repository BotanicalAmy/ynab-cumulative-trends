# YNAB Cumulative Trends

## Problem

Zero-based budgeting accounts for every dollar, but that means investments and savings often flow into a "spend" category too, obscuring your real savings rate. Without cumulative trends, it's hard to see how spending in a category builds over the year until it's already a problem.

## Solution

I wrote a Tampermonkey userscript that adds cumulative **Income vs. Spend** and **Category Trends** above YNAB's native monthly bar chart. These visuals show how income and spending trends build through the year, making trends easier to identify. The category trend was motivated by my desire to watch lifestyle creep in key categories, such as spending on eating out and personal services.

> The illustrations below use fabricated sample data 

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
- **No server, no build step.** A single self-contained userscript — JavaScript and inline SVG, no charting library or backend.
- **Dynamic budget detection.** The script reads your budget ID straight from the URL (e.g. `https://app.ynab.com/<BUDGET_ID>/reflect/spending-trends`), so it works for any budget with no configuration.
- **Secure token storage.** Your token is stored locally via Tampermonkey's `GM_setValue`, never written into the script file itself.

## Setup

1. In YNAB, go to **Account Settings → Developer Settings → New Token** and copy it. You won't need to save it anywhere else — it goes straight into the one-time prompt in step 5.
2. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
3. Enable **Allow User Scripts** for Tampermonkey at `chrome://extensions` (required on recent Chrome versions, or scripts won't run).
4. Create a new Tampermonkey script, paste in the entire contents of [`CumulativeTrends.js`](CumulativeTrends.js), and save.
5. Open a YNAB Spending Trends page — `https://app.ynab.com/<BUDGET_ID>/reflect/spending-trends` — and reload. The script only runs on this page, and you'll get a one-time browser prompt for the token from step 1.
6. The native chart is replaced with Income vs. Spend and Category Trends (if the native chart can't be found, these are added above it instead). Category Trends defaults to Enjoyment/Wellness/Subscriptions — change the defaults by editing `CONFIG.DEFAULT_CATEGORY_TRENDS_GROUPS` near the top of the file, or use the picker on the chart itself (your picks persist until you reload the page).

To change or clear the stored token, use **Reset YNAB API Token** from the Tampermonkey extension menu (click the Tampermonkey icon while on a YNAB tab). A rejected token (for example, after rotating it in YNAB) is also cleared automatically, and you'll be re-prompted on your next visit.

## How it works

The script calls YNAB's public [API](https://api.ynab.com/) directly from your browser, so there's no server involved. Data is fetched once per year you select, then all the cumulative math and chart rendering happens client-side. Your token stays in Tampermonkey's local storage.

## Disclaimer

This is an independent, unofficial project and is not affiliated with or endorsed by YNAB. It uses YNAB's published API to read your budget data and never modifies it.

## License

[MIT](LICENSE)
