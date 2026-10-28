# PDF Explorer

A local web page to browse a folder of PDFs as covers and read them in one continuous scroll.

## Usage

Open `index.html` in Chrome, Edge or another Chromium browser, then pick the folder that holds your PDFs. Chrome does not grant access to the home folder itself, so pick a folder inside it.

## Technical details

The page reads files through the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API), which Firefox and Safari lack. It renders PDFs with [pdf.js](https://mozilla.github.io/pdf.js/) 3.11, kept in `vendor/pdfjs` because later versions are ES modules, which Chrome does not load from `file://` pages. `scripts/vendor-pdfjs.sh` downloads it again.
