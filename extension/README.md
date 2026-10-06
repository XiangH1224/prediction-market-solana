# Prediction market panel (Vite, React, crxjs)

A page that lists Kalshi events, analyses the one you pick, and shows the verdict, the
reasoning and the news sources behind it. Purchases are simulated unless the backend has a
DFlow key, in which case trades the backend has dry-run can be signed with a wallet.

The look comes from the GDELT interface on `master`: `public/gdelt/` holds its
`bootstrap.min.css`, `custom.css` and Font Awesome files unchanged, and the page uses the
same markup (navbar, `#side_panel`, tab rows, `#main_panel` title row and results pane).
`src/index.css` only adds rules that interface has no equivalent for.

## Use it as a page

```bash
cd extension
npm install
npm run build
```

Start the backend (see `backend/README.md`) and open http://localhost:8000/panel.

## Use it as a Chrome side panel

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`extension/dist`. Click the extension's toolbar icon to open the panel.

## Wallet

Wallet extensions do not inject into another extension's pages, so the side panel reaches
the wallet through a pinned tab at `http://localhost:8000/wallet`, using the Wallet
Standard `solana:signAndSendTransaction` feature. This path has not been tested in a browser.
