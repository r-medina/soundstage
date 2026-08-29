# Publish checklist

## 0. One-time accounts

- [ ] GitHub account that can create **github.com/r-medina/soundstage** (or another name)
- [ ] [Chrome Web Store developer](https://chrome.google.com/webstore/devconsole) account  
      Google charges a one-time registration fee (historically US$5)

## 1. GitHub (public)

From the repo root:

```bash
git add -A
git status   # vendor/three.min.js should be included
git commit -m "Prepare public release and Chrome Web Store listing"
```

Create and push (GitHub CLI):

```bash
gh repo create r-medina/soundstage --public --source=. --remote=origin --push
```

Or on github.com: **New repository** → public → empty (no README) → then:

```bash
git remote add origin git@github.com:r-medina/soundstage.git
git push -u origin main
```

Confirm these load **without signing in** (incognito):

- https://github.com/r-medina/soundstage
- https://github.com/r-medina/soundstage/blob/main/PRIVACY.md

If the GitHub name is not `r-medina/soundstage`, update the URLs in `PRIVACY.md`, `SECURITY.md`, and `store/LISTING.md` before submitting the store listing.

## 2. Package the extension

```bash
scripts/package-extension.sh
```

That writes `store/dist/soundstage-<version>.zip`. Unzip it somewhere and **Load unpacked** that folder once as a sanity check.

The zip contains only runtime files (manifest, background, `src/`, `icons/`). Lab pages and store copy stay on GitHub.

## 3. Chrome Web Store

1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. **New item** → upload `store/dist/soundstage-<version>.zip`
3. **Store listing** — paste from `store/LISTING.md`  
   Upload `icons/icon128.png`, `store/promo/small-tile.png`, `store/promo/marquee.png`, and the five `store/screenshots/*.png` (start with `01-magnetosphere.png`)
4. **Privacy** — paste justifications from `store/LISTING.md`  
   Privacy policy URL = the public `PRIVACY.md` link  
   Remote code = **No**
5. **Distribution** — Public, Free
6. Submit for review

Review can take from hours to several days. `tabCapture` sometimes gets extra scrutiny; the privacy copy is written for that.

## 4. After it ships

- Add the store URL to the README badge line
- Tag a release: `git tag v1.7.0 && git push --tags`
- Future updates: bump `manifest.json` `version`, run `scripts/package-extension.sh`, upload a new zip on the same item
