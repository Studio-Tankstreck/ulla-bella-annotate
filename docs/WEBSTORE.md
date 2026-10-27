# Ulla-Bella — Chrome Web Store metadata draft (Task 14)

> Draft only. **Do not submit.** the maintainer owns the Chrome Web Store developer
> account and completes submission manually (see the Task 14 report, section
> 16). Replace the `[...]` placeholders before publishing.

## Recommended visibility

**Unlisted** for the first private beta. Rationale: the intended pilot is a
small number of customers reached by a direct install URL, with the least
account administration. **Private** (Web Store tester/organization groups)
fits only if every beta tester is explicitly listed and managed in the
dashboard, which is heavier than the pilot needs. Both are available; switching
from Unlisted to Private/Public later does not require a new extension ID.

## Listing fields

| Field | Draft |
|---|---|
| Extension name | Ulla-Bella |
| Short description | Point at an element on your website and tell Ulla-Bella what to change. |
| Category | Productivity |
| Language | English (the listing); the extension UI ships English, Svenska, Deutsch, Español, Italiano, Nederlands, Norsk bokmål, Dansk and Suomi — see `docs/I18N.md` |
| Version | 0.1.0 |
| Visibility | Unlisted |

## Detailed description

Ulla-Bella lets you change your website by pointing at it. On a website you
have connected, click the Ulla-Bella icon, select the element you want to
change, describe the change in plain words, and send it. Ulla-Bella hands the
instruction to your site's editing service and reports when the change is done.

This is a private beta. A website becomes available for editing only after you
import a `.ullabella` connection file issued to you. Ulla-Bella does not read
pages you have not explicitly connected.

## Single purpose

Ulla-Bella has one purpose: to forward an editing instruction you explicitly
compose for an element on a connected website, and to show you the result.

## Permission justification

| Permission | Why Ulla-Bella needs it |
|---|---|
| `storage` | Store the connection settings and device credential for the website you connected, locally on your device. |
| `scripting` | Register the editing UI (a small overlay) on the website you connected, and nothing else. |
| `activeTab` | Read the current tab's address when you open the Ulla-Bella popup, so it can tell you whether that page belongs to your connected website. |
| Optional site host access | After you connect a website, Ulla-Bella asks once for access to that website's pages, so it can show the editing UI there. No access to any other site is requested or granted. |
| Relay host access | Talk to the single Ulla-Bella Relay server that forwards your instruction. |

## Privacy summary (listing)

Ulla-Bella sends information only when you explicitly select an element and
send an instruction, and only to the single Ulla-Bella Relay server. It sends
the page URL, page title, the selected element's visible text, its type,
selector and DOM hints, nearby text, and your instruction — the minimum context
needed to locate and edit that element. Nothing is sent while you merely
browse. The device credential is stored locally and sent only to the Relay.

## Support URL / homepage URL

- Support: `[https://.../support]`
- Homepage: `[https://ulla-bella.ai]` (placeholder)

---

# Privacy & data-flow input (Task 14, Part 20)

Technical description of data access — the basis for the eventual Web Store
privacy disclosure. Not legal boilerplate.

## What browser data is accessed

- **Connected website pages only** (the origin you imported via `.ullabella`).
  Ulla-Bella holds optional host access for that origin and registers a content
  script there. It has **no** access to pages on any other site.
- **Active tab address** when the popup is open (`activeTab`), to determine
  whether the current page belongs to the connected website.

## When access occurs

- Reading the page happens **only after you open editing mode and select an
  element**. Browsing a connected site without selecting an element sends
  nothing.
- The content script reads the DOM only when you click an element to edit it.

## What is transmitted (and when)

On **Send**, the extension transmits one annotation to the Relay:

- page URL (of the connected site)
- page title
- the selected element's **visible text** (truncated)
- element type, selector, and DOM path (structural hints)
- nearby text (short, truncated context)
- your instruction text

It is sent to exactly one destination: the Ulla-Bella Relay (the origin
approved at pairing). It is not sent to the website you are editing, and not to
any third party.

## Credentials stored locally

- The paired Site's **device credential** is stored in `chrome.storage.local`.
  It is sent only to the Relay as a bearer token.
- Hermes, MCP, and CMS credentials are **never** present in the extension.
  They live on the Adapter/Hermes side, outside Chrome.

## What is not sent to websites

Ulla-Bella does not send data to the website being edited. The Relay receives
the annotation and forwards it to the installed Adapter over an authenticated
WebSocket; the browser never holds or sends Hermes/CMS credentials.

## Data retention

The extension stores only the connection settings for the single connected
website. Removing the extension (or clearing its storage) removes that data
from the device. Server-side retention is governed by the Relay/Adapter
operators, not by this extension.
