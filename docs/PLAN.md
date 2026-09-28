# PLAN — AI Mail App

Status: **approved 2026-09-27; Phases 0–8 done**. Vision: `docs/AI Mail App — Build Spec for Claude Code.md`.
Where this plan and the spec disagree, **this plan wins** (it carries the user's answers below).

> **TODO (user): add `BODY_SIZE_LIMIT=26M` to `.env` and `.env.example`.** SvelteKit's adapter-node rejects request bodies over 512 KB by default, so replies with attachments (up to 25 MB) fail until this is set.
>
> **TODO (user): add `MODEL_API_KEY=` (and optionally `MODEL_BASE_URL=`, default `https://api.z.ai/api/paas/v4`) to `.env` and `.env.example`.** `callModel` throws until the key is set.

## 1. Decisions from the user (2026-09-27)

These override the spec where they conflict.

| # | Topic | Decision |
| --- | --- | --- |
| A | Users | **Single user, runs locally only.** better-auth stays for future work, but storage is single-user: one `data/profile/user.json`. |
| B | First sync | On first start, **backfill every email** in each account, then keep syncing from the highest UID seen. |
| C | Sync interval | Every **5 minutes**, in the background (not on page load). |
| D | Accounts | Multiple accounts, each with its own inbox and outbox. **A reply is sent from the account the email arrived on.** |
| E | SMTP | Same username/password as the account's IMAP login. |
| F | Files to the AI | **No local parsing, no OCR.** Known file types (PDF, DOCX, XLSX, CSV, TXT, MD, common images) are sent to the model as they are. Anything else (`.exe`, archives, scripts, unknown types) is **never read, opened or sent to the AI**. *Relaxed in Phase 8, for resource search only:* TXT, MD, CSV, DOCX and XLSX resources are read locally for their text, and PDF and image resources are transcribed by the AI once when uploaded. That text is only searched; it is never shown or sent with a draft. |
| G | Local processing | The AI reads the files and writes the content. The only local file work is **building the output file** from what the AI wrote. |
| H | E2B | **Dropped.** |
| I | Output formats | **PDF, DOCX and XLSX** for now. |
| J | Intermediate format | The AI writes documents as **Markdown**. Local code renders that Markdown to PDF or DOCX. Spreadsheets are written as JSON sheets and rendered to XLSX. **No LibreOffice.** |
| K | Server-side deletes | When an email is deleted on the server, **everything local that came from it is removed**: the email, its drafts, its stored attachment versions and any generated files. |
| M | Inbox | **One combined inbox** across all accounts. Each row shows which account it arrived on, and replies go out from that account. |
| N | Categories | Every email is tagged with its category (primary, social, promotions, updates, forums) **fetched from the server**, and appears under that tab in the combined inbox. |
| L | Model | If GLM 5.3 Flash can't take file inputs, the user will switch models. The model interface assumes file input is supported. |

What changes from the spec because of this:
- **E2B is removed.** There is no sandbox. Nothing runs from a received file.
- **No DOCX working copy.** The working copy is `working.md`, the AI's Markdown version of the document. See Phase 4.
- **No parsed `.txt` next to each version** and no OCR. Positions in change notes (page and clause) come from the model reading the file itself.
- **Resource search** works on names, keywords and tags, and (since Phase 8) on the text inside the file.
- **Template field detection** is done by the model reading the template file directly.

## 2. What exists today (audit)

Stack: SvelteKit 2 + Svelte 5, Tailwind 4 + shadcn-svelte, Drizzle + SQLite (`better-sqlite3`), better-auth, `imapflow` + `mailparser`, Vitest + Playwright.

| Area | Reality in the code |
| --- | --- |
| IMAP sync | `mailSync.ts`: `INBOX` only, newest 25 on first sync, runs on page load only when the cache is more than 10 minutes old. Only the **oldest** account is ever synced or shown. |
| Threads | `email.threadId` is worked out per message. There is no `thread` table. |
| Attachments | Only metadata is kept (name, type, size). **The file bytes are thrown away.** |
| Tracking | `tracked_person(userId, email)` (replaced by `contact` in Phase 1). |
| AI drafting | **Not present.** There is no model client, draft table or AI dependency. |
| Sending | Replies are sent over SMTP from the receiving account (Phase 0, step 2). |
| Tests | `crypto.spec.ts` (3 tests), `mail.spec.ts` (4 tests). None for sync, tracking or routes. |

### Sync bugs to fix (in answer to "deleting an email messes with UIDs")

How IMAP behaves: within one mailbox, **UIDs never change and are never reused while `UIDVALIDITY` stays the same**. Deleting an email leaves a gap in the UIDs. It does not renumber them. **Sequence numbers** (1..N) *do* shift when an email is deleted, so the code must never store or resume from them.

Current code issues:
1. **First sync uses sequence numbers** (`exists - limit + 1 : *`, `uid: false`). This works as a one-off, but it is the wrong basis for a backfill. Fix: backfill by UID, `1:*` in ascending order, in batches.
2. **A `UIDVALIDITY` change only refetches 25 messages.** The server says every stored UID is now meaningless, but the code falls back to "newest 25" and leaves stale rows behind. Fix: when validity changes, do a full re-backfill of that mailbox and drop that mailbox's rows that carry the old validity.
3. **`getNewestPosition` orders by `uidValidity DESC`.** Validity values are arbitrary numbers, not increasing ones, so after a change it can resume from the wrong generation. Fix: store the sync position per mailbox in a table (`mailbox_state(accountId, mailbox, uidValidity, lastUid, highestModseq)`) instead of deriving it from `email` rows.
4. **An interrupted backfill.** Fetching in ascending UID order and saving `lastUid` after each batch lets a crash resume where it stopped instead of starting again.
5. **Two syncs at once** (a page load and the worker) can race. Fix: only the worker syncs, one account at a time, with an in-process lock.
6. **Server-side deletes are not mirrored.** An email deleted on the server stays in the local cache. Fix: on each sync, run `UID SEARCH ALL` on the mailbox and delete the local rows whose UID is no longer on the server. Safety guards:
   - Delete only after the search **completes successfully**. A dropped connection must never count as "the server has nothing".
   - Delete only when `UIDVALIDITY` hasn't changed. A change is handled by bug 2's resync instead.
   - Everything from that email is removed: the email row, its drafts, its attachment versions (the file and its row; `meta.json` is rewritten) and its generated files. A person summary that links to a removed file keeps the text but marks the link `(deleted)`.

## 3. Phases

Every phase is done in small commits. After each phase I update this file and summarise what changed and how to test it.

### How the sync works (Phase 0)

Today only the newest 25 emails are stored. Once Phase 0 is in, this is how syncing works:

1. **Full backfill on the first start.** When the app starts, the background worker checks `mailbox_state` for each account's INBOX and Sent folder. A folder with no row there has never been backfilled, so the worker fetches **every email** in it by UID (`1:*`, lowest first), in batches of 100.
   - **The 25 emails you already have are covered.** No mailbox has a `mailbox_state` row yet, so the first run backfills the full history. The 25 existing rows are skipped by the unique key (`onConflictDoNothing`), so they are neither duplicated nor refetched as new.
   - After each batch, `lastUid` is saved. If the app is closed mid-backfill, the next start picks up from that UID.
   - The inbox shows emails as each batch lands, with a "Syncing N of M" indicator. You don't wait for the whole mailbox.
   - When the model and tracking are active, only emails from tracked people **that arrive after the backfill** go through the AI pipeline. The backfill doesn't draft replies to years of old mail.
2. **Constant sync every 5 minutes.** One worker runs straight away on start and then every 5 minutes. For each account and folder it:
   - fetches `lastUid + 1 : *`, which gets only the new mail
   - removes local emails deleted on the server (with the guards in bug 6)
   - does a full resync if `UIDVALIDITY` changed
3. **Page loads never sync.** They read only from the local database, so opening the app is instant, even during the first big backfill.

`ponytail:` each email's full source is parsed during the backfill. On a very large mailbox, the first sync takes a while, but it only happens once and it runs in the background.

### Phase 0: Foundations (sync done right, sending, model interface, job runner)

- **Touches:** `mailSync.ts`, `mail.ts`, `mailAccount.ts`, `hooks.server.ts` (starts the worker), `/home` layout (loads from the cache only), `mail.schema.ts`, `svelte.config.js` (switch to `adapter-node`, since the app is a long-lived local process)
- **Adds:**
  - `mailbox_state` table (the sync position, see above)
  - A full UID backfill on first start, then an incremental sync (see "How the sync works" above), covering **every account** and each account's **INBOX + Sent** (Sent is found by its `\Sent` special-use flag)
  - `jobs/worker.ts`: runs a sync at startup and then every 5 minutes, plus a job table for the AI pipeline with retries. `ponytail:` in-process, with no Redis.
  - A sync-progress indicator in the sidebar
  - `smtp.ts`: `nodemailer` (new dependency) using the account's IMAP credentials. The SMTP host and port are guessed from the IMAP host (`imap.x` → `smtp.x`, port 465) and can be edited in the account dialog. Sent mail is appended to that account's Sent folder.
  - `email.direction` (in or out) so sent replies feed the person summary
  - **Combined inbox:** `listCachedThreads` reads across every account instead of only the oldest one. Each row carries its `accountId` and shows the account's label.
  - **Categories:**
    - Add `CategoryForums` → `forums` to the existing Gmail label map (`mail.ts`), so the tabs are primary, social, promotions, updates and forums.
    - Categories are already fetched for new mail (`X-GM-LABELS`). The backfill fetches them the same way, so every old email lands in the right tab too.
    - Keep categories current: when Gmail moves an email to another tab, the 5-minute sync picks that up with a flags-only fetch using `CONDSTORE` `changedSince <last modseq>` (no bodies downloaded). The modseq is stored in `mailbox_state`.
    - Non-Gmail accounts have no server categories, so their mail goes to primary. `ponytail:` no AI classifying; add it only if a non-Gmail account needs tabs.
  - `ai/model.ts`: one `callModel(agent, messages, files)` interface. GLM 5.3 Flash, with the model set per agent in config. It accepts file inputs.
  - `files/allowlist.ts`: one function, `isReadableByAI(filename, mime)`. Every path that sends a file to the model goes through it.
- **Migrations:** `mailbox_state`, `job`, `mail_account.smtp_host` / `smtp_port`, `email.direction`
- **Tests:**
  - backfill in batches, then an incremental sync picks up only new UIDs
  - a database already holding 25 emails backfills the older ones with no duplicates
  - gaps in the UIDs (deleted mail) cause no refetch or skip
  - an email deleted on the server is removed locally, and a failed search deletes nothing
  - a `UIDVALIDITY` change triggers a full resync and removes stale rows
  - an interrupted backfill resumes where it stopped
  - the allowlist rejects `.exe`, `.zip` and `.js`
  - the send path uses the receiving account

**Progress**
- **Step 1, sync done right: done (2026-09-27).**
  - **Schema and migration:** `mailbox_state` and `email.direction` (migration `0005`).
  - **Sync code:**
    - rewritten `mailSync.ts`
    - `mailboxState.ts`
    - `mailCache.ts` (combined inbox and thread reads)
    - `syncWorker.ts`, started from the `init` hook
  - **UI:**
    - sidebar Forums tab
    - `SyncStatusBar`
    - account label on each row when there is more than one account
    - `/home/[id]` in place of `/home/[uid]`
  - **Tests:** `mailSync.spec.ts`, `mailCache.spec.ts` and `syncWorker.spec.ts`, against a fake IMAP server (`src/lib/server/testing/fakeImap.ts`) and an in-memory DB built from the real migrations.
- **Step 2, SMTP reply: done (2026-09-27).**
  - `smtp.ts` with `sendReply`. It sends from the account the email arrived on.
  - **Custom SMTP:** nullable `mail_account.smtp_host` / `smtp_port`, set in the account dialog (prefilled with smtp.gmail.com:465). Port 465 uses TLS, and any other port uses STARTTLS. When the columns are null, the host is derived from the IMAP host (`imap.x` → `smtp.x`, port 465).
  - **Headers stored locally:** `cc`, `replyTo`, `messageId` and `references` are saved at sync. Threading headers are built from the cache, with no IMAP round trip.
  - **Replies go to the latest message in the thread**, including one you sent yourself. If it was yours, the reply is a follow-up to its original recipients.
  - **CC:** prefilled from the message and editable. To is shown read-only.
  - **Attachments:** multipart upload with a 25 MB total. The Sent copy includes them.
  - A copy is appended to Sent, except on Gmail, which files sent mail itself. The reply reaches the thread on the next sync.
  - UI: `ReplyBox` under the thread on `/home/[id]`, using a `reply` form action.
  - **Tests:** `smtp.spec.ts` covers threading, follow-up, CC, attachments, custom SMTP and the size limit. `mailSync.spec.ts` covers stored headers. nodemailer is mocked, so no real mail is sent.
- **Step 3, model interface and job runner: done (2026-09-27).**
  - `svelte.config.js` uses `adapter-node`. Run with `npm run build && node build`.
  - **Mail sync and the job runner run only while the Node server is running.** Both start in the `init` hook and stop with the process. There is no background daemon.
  - `job` table (migration `0008`) and `jobs/worker.ts`: `registerJobHandler`, `enqueueJob`. It polls every 5 seconds and runs one job at a time. Failures retry with backoff (30s, 60s, ...) up to 5 attempts, then the job is marked `failed`. Jobs left `running` by a stopped process are put back to `pending` on start.
  - `files/allowlist.ts`: `isReadableByAI`. Extension and MIME type must both match.
  - `ai/model.ts`: `callModel(agent, messages, files)` against an OpenAI-style `/chat/completions` endpoint. The model is set per agent (all GLM 5.3 Flash for now). Files go through the allowlist; images are sent as `image_url` and other files as `file` parts.
  - **Tests:** `worker.spec.ts`, `allowlist.spec.ts`, `model.spec.ts`. `fetch` is mocked, so no real model call is made.

### Phase 1: Storage, user profile, person summaries, thread cutting

- **Adds:**
  - `data/` root (`DATA_DIR`, default `./data`) with the spec's layout, minus the parsed-text files
  - `contact` table (name, company, emails, tracked flag). Replaces `tracked_person`, which is dropped without copying its rows (the app is still in development).
  - `thread` table
  - `data/profile/user.json` + `/settings/profile`
  - `ai/agents/memory.ts`: updates the summary incrementally, writes `contacts/<id>/summary.md`, and moves the previous version into `summary_history/`. There is a manual rebuild, and user edits are kept.
  - `ai/context/stripQuotes.ts` + `cutThread.ts`: a configurable budget that keeps the first message and the message being replied to, drops the oldest first, and logs each cut
  - Person page `/people/[id]`: summary, threads, documents, tracking toggle
- **Migrations:** `contact`, `thread`, `summary_version`, and a backfill of `thread` from `email.thread_id`
- **Tests:** summary update keeps user edits; the thread-cut rules; quote stripping on Gmail and Outlook samples
- **Done (2026-09-27).**
  - Migrations `0009` (drops `tracked_person`) and `0010` (`contact`, `thread`, `summary_version`, backfill of `thread` from `email.thread_id`).
  - `storage/paths.ts`: every on-disk path under `DATA_DIR`. `profile.ts` + `/settings/profile` (sidebar link "Your profile").
  - `threads.ts`: sync upserts `thread` rows, links them to tracked contacts, and queues a `memory.update` job per new message. **Only mail dated after tracking started is queued**; older mail comes in through Rebuild, so the first full sync does not make one model call per historical message.
  - `ai/agents/memory.ts`: `memory.update` and `memory.rebuild` jobs. Each write archives the old `summary.md` to `summary_history/<time>.md` with a `summary_version` row. The `## My notes` section is carried over verbatim on model writes; a user edit is stored as typed.
  - **Rebuild** runs as a job. It packs whole threads (a lone email counts as a thread of one), oldest first, into calls of up to `REBUILD_BUDGET_TOKENS` (default 32000). Most people take one call; long histories take a few, each building on the last summary. After that, each new email is folded in with its own call.
  - `cutThread.ts`: budget `THREAD_BUDGET_TOKENS` (default 8000, about 4 characters per token). Cuts that drop messages are logged to `logs/agents/thread-cuts.jsonl`.
  - `/people/[id]`: editable summary (Save, Rebuild), tracking switch, **every email** sent to or received from them (not only threads), and their attachments. Reached from the tracked-people list in the Mailboxes dialog.
  - **Tests:** `memory.spec.ts`, `cutThread.spec.ts`, `stripQuotes.spec.ts`. The model is mocked.

### Phase 2: Drafting with placeholders (triage folded in), manual merge

- **Adds:**
  - **No separate triage step.** One drafting call returns JSON `{reply_needed, reason, body}`. When no reply is needed (thanks, FYI), a `skipped` draft keeps the reason and the thread page offers **Draft anyway**.
  - `ai/context/buildContext.ts`: bundles the profile, the person's summary and the thread (cut if needed); resources come later
  - `ai/agents/drafting.ts`: writes the reply with `[[name]]` placeholders. It runs as a `draft.create` job queued after each email's `memory.update`, so the draft sees the updated summary. Only for tracked people.
  - **Every email from a tracked person gets a draft**, whether it starts a new conversation or replies in a thread.
  - **Merge is manual.** Only the incoming emails after the user's last reply ("unanswered") count. Each gets its own draft; when two or more are pending, a **Merge** button rewrites them into one reply on the latest email. The source drafts become `merged`.
  - `placeholders.ts`: finds, counts and fills placeholders; shared by the server and the UI
  - `agent_run` log table
  - Draft review in `/home/[id]`:
    - the reply box is prefilled with the draft; Tab selects the next `[[placeholder]]`; the unfilled ones are listed under it
    - **Send stays disabled until every placeholder is filled**, and `sendReply` refuses on the server too
    - regenerate with an optional instruction, discard, merge, draft anyway
    - sending closes the thread's drafts: the one used becomes `sent`, the rest `discarded`
  - Inbox draft badges and a "Drafts waiting" filter (`/home?drafts=1`)
- **Migrations:** `draft` (pending / skipped / merged / sent / discarded), `agent_run`
- **Tests:** placeholder parsing; skip vs draft; draft anyway; merge covers only unanswered emails; Send refused with placeholders; the full pipeline from `memory.update` to a draft
- **Done (2026-09-27).**
  - Migration `0011_drafts` (`draft`, `agent_run`).
  - `drafts.ts`: unanswered emails, ownership checks, open drafts, closing a thread's drafts after a send, per-thread pending counts for the inbox.
  - Regenerate, merge and draft anyway run inside the request (one model call each), not as jobs.
  - Replying from another client hides old drafts on the thread page (they are no longer "unanswered"), but they still count in the inbox badge until the thread is replied to from the app.
  - Components: `draft/DraftBar.svelte`, `draft/PlaceholderList.svelte`, `ReplyBox.svelte`.
  - **Tests:** `placeholders.spec.ts`, `drafting.spec.ts`, and the placeholder case in `smtp.spec.ts`. The model is mocked.
  - **Not done yet:** colour highlighting inside the textarea, draft files under `data/drafts/`, the "why" panel (Phase 7).

### Phase 3: Attachment storage and versioning (no parsing) — done

- **Download for every email** (tracked or not):
  - `attachments.ts` `fetchEmailAttachments` fetches the message live from IMAP by uid. Nothing is stored.
  - `/attachments/[emailId]/[index]` checks ownership (404 otherwise) and returns 410 if the message is gone or `uidValidity` changed.
  - Always a forced download: `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`. An HTML or SVG attachment can't run in the app.
  - Attachment chips in `ThreadMessage` are download links.
  - `mail.ts` `fileAttachments` keeps attachment indexes aligned between the stored row and the live fetch; inline images are excluded.
- **Ingestion for tracked people only** (`files/ingest.ts`):
  - `attachments.ingest` job per email with attachments. It is queued by `recordInsertedEmails` for all mail with a tracked person, old or new.
  - `attachments.backfill` job when tracking starts or is re-enabled (`trackedPerson.ts`). It queues ingest for every past email with the person.
  - Storage: `attachments/<doc-id>/vN.<ext>` plus a `meta.json` (sender, message id, date, sha256, readable, replaces).
  - A file whose sha256 is already stored for the person is skipped.
  - Next version when a version in the same thread has the same extension and the same normalized filename (`normalizeFilename` drops v2, (1), dates, final/signed/…). Otherwise it becomes a new document.
  - Non-allowlisted files are stored with `readable = false` and never passed to the model.
  - A deleted or renumbered message is skipped, not retried.
- **Documents UI** (`PersonDocuments`, `DocumentMergeForm`):
  - version history, where each version downloads via `/files/[versionId]` (ownership-checked, forced download)
  - an "unreadable" badge
  - merge two documents: the versions and files move, are renumbered by received date, `meta.json` is rewritten, and the emptied document and its folder are deleted
- **Skipped:**
  - "decide by what the email says" and content similarity. The filename match plus a manual merge covers these; if misses are common, ask the model once it reads files (Phase 4).
- **Migration:** `0012_documents` (`document`, `document_version`)
- **Tests:**
  - `attachments.spec.ts`: download from an untracked sender, forced octet-stream, another user gets 404, a bad index gets 404, a renumbered mailbox gets 410
  - `files/ingest.spec.ts`:
    - the same file twice gives one version
    - a revised file becomes v2
    - an unrelated file becomes a new document
    - an `.exe` is stored with `readable = false`
    - an untracked sender is ignored
    - tracking someone backfills their files
    - merge renumbers and moves the files
    - merge refuses another user's documents
    - `normalizeFilename` cases

### Phase 4: Document output (the AI writes Markdown or sheets, local code renders the file) — done

- **Asked for by the drafting call.** The context lists the person's documents (id, name, latest version). The reply JSON has `documents: [{document_id | null, change}]`, only when a message asks for a file. Regenerate goes the same way.
- **`ai/agents/document.ts`:** one model call per requested document. It returns `{contract, name, change_note, markdown | sheets}`.
  - Source, first match wins:
    1. another pending draft's file for the same document (not drafts on the same email, since a regenerate replaces those)
    2. the working copy, if `working.json.fromVersion` equals the latest version
    3. the latest received file, sent as a model file; an unreadable one is an error
    4. nothing, for a new document
  - Format: xlsx/xls/csv → XLSX; DOCX → DOCX unless the model says it's a contract (then PDF); everything else and every new document → PDF.
  - Name: the previous filename with a trailing `vN` stripped, then ` v<next>`. The next number is above both the stored version and any number already in the name. A new document uses the model's cleaned-up name.
  - Output: `generated/<thread>/<id>/` holds the file, `<file>.changes.md` and `source.md` or `source.sheets.json`. For an existing document the change note always says the file was rebuilt from text.
  - Any model or render failure becomes a `generated_file` row with `error`; the draft is still written.
- **Renderers** (`files/render/`):
  - `pdf.ts`: `marked` → HTML → Chromium `page.pdf()`. Raw HTML and images are escaped, JavaScript is off and every request is aborted.
  - `docx.ts`: headings, paragraphs, lists (numbered ones get a typed prefix), tables, bold/italic/strike and code.
  - `xlsx.ts`: values only; sheet names cleaned and made unique.
- **Merge** moves the source drafts' files to the merged draft.
- **Sending** (`files/generated.ts`):
  - the reply attaches the draft's rendered files alongside the uploads
  - afterwards each becomes the next `document_version` (sender = your address, no email) or a new document, deduped by sha256
  - its source becomes `working.md` or `working.sheets.json` with `working.json {fromVersion}`
  - a failure here is logged, since the mail has already gone
- **UI:** `DraftFiles` under the draft controls. Each file has a download link via `/generated/[id]` (ownership-checked, forced download), a collapsible "What changed", the error if it failed, and Remove, which deletes the row and its folder.
- **Skipped:**
  - parallel document edits (one at a time per draft)
  - swapping an attachment (Remove it, then regenerate with an instruction)
  - cleanup when an email is deleted on the server (done in Phase 8)
  - the "why" panel (Phase 7)
- **Migration:** `0013_generated_files` (`generated_file`)
- **Tests:**
  - `files/render/render.spec.ts`: a real Chromium PDF, escaped HTML, DOCX heading and table, XLSX cells and unique sheet names
  - `ai/agents/document.spec.ts`:
    - the format rule
    - DOCX in gives DOCX out, with the file sent to the model
    - a contract gives a PDF
    - an XLSX gives an XLSX
    - a pending draft's version is the source
    - a failed render shows on the draft, and Remove deletes it
    - sending attaches the file, stores the next version, and the next edit starts from the working copy
- **Trade-off:** the document is rebuilt from Markdown, not edited in place. Headers and footers, signature images and complex layout from the original are lost. The change note says so whenever the source had them.

### Phase 5: Templates — done

- **Adds:**
  - `template` table and `templates/<id>/`: `original.<docx|xlsx|pdf>`, the marked copy (`template.docx`, `template.xlsx`, or `template.md` for a PDF) and `template.json` (name, description, fields).
  - **Filled in place, not rebuilt** (user's choice, "option 2"): Word and Excel templates keep their exact layout. `files/fill/officeXml.ts` works on the zip's XML: it finds a field's text across Word runs within one paragraph, puts `[[field]]` in the first run (keeping its formatting) and removes the rest of the text from the others. Filling swaps the markers for XML-escaped values. Excel goes through the same path (shared strings and sheet XML), not ExcelJS, so charts and styles survive.
  - `template.prepare` job (on upload and on replace). DOCX/XLSX: the model gets the document's text one paragraph per line and returns `{fields: [{name, description, text: [exact strings]}]}`; local code marks them. PDF: the model reads the file and returns the fields plus the whole document as Markdown with `[[field]]` markers. Each field stores `found`; 0 shows "not found in the file". Status `processing` → `ready` or `failed` with the reason (no automatic retry; replacing the file retries).
  - Upload accepts only DOCX, XLSX and PDF (extension and MIME must agree), up to 25 MB.
  - `/settings/templates` (sidebar link): upload, the list with status and fields, rename and describe, replace the file, delete (row and folder). The page refreshes while a template is being processed.
  - Drafting: the context gets a `[TEMPLATES]` list (ready ones only). A document entry can carry `template_id`. A standard document (NDA, contract…) with no fitting template gives `missing_template`: an error row on the draft saying to upload one and regenerate. Nothing is made from the closest template.
  - Filling: one model call returns `{values, change_note}` (the note says where each value came from). Unknown values are null and stay `[[field]]`. The file keeps the template's format, named "<template> - <person>.<ext>". The document agent (Phase 4 edits too) now also gets the draft's background: profile, summary and thread.
  - `generated_file.placeholders`: the fields still in a file. The draft shows an input per field; "Update file" fills them (re-rendered from the source for Markdown or sheets, straight into the XML for a Word/Excel template). Send is disabled while any attached file has fields, and the reply action refuses it server-side.
  - After sending, the file becomes a document of the person like any Phase 4 file.
- **Migrations:** `0014_templates` (`template`; `generated_file.template_id` and `placeholders`)
- **Tests (`templates.spec.ts`):**
  - marking a sample NDA with a field split over two runs, with counts and `&` escaping
  - the prepare job's fields and `found` counts, including a field not in the file
  - upload refuses a .txt and a renamed .exe
  - delete removes the row and the folder
  - a draft fills the NDA, leaves the unknown date as `[[effective-date]]`, Send is refused, the user fills it, then it sends
  - no template fits: an error row, no file
- **Not done:** DOCX → PDF conversion of a filled contract (later, e.g. LibreOffice headless); editing the detected fields by hand; turning a PDF template into Word. A marker only matches within one paragraph, and a blank like "____" shared by different fields can't be told apart, so those show as "not found".

### Phase 6: Resources and keyword retrieval — done

- **Adds:**
  - `resource` table and `resources/<id>/original.<ext>`. Upload accepts only files the AI can read (the decision F allowlist; extension and MIME must agree), up to 25 MB.
  - `resource_fts`: an FTS5 table over name, keywords and tags, kept in step by SQLite triggers on insert, update and delete. Hand-written in the migration; drizzle does not model it.
  - Search is local, with no model call: words from the subject and body of the email(s) being answered, minus common words, at most 30. Each is quoted as a prefix (`"price"*`) and joined with OR, so nothing in an email can act as FTS syntax. Ranked by bm25 (name 10, keywords 5, tags 2); the top 3 are used.
  - Drafting: the context gets a `[RESOURCES]` list (name, file, tags, last updated, newest first) and the files go to the model. The document and template agents get the same list and files. Merged drafts search with all the waiting emails.
  - When resources disagree the model uses the newest and reports it in `"conflicts"`. `draft.resources` keeps `{id, name}` of what was sent (so the record survives a delete) and `draft.conflicts` the reports. The draft shows "Used: …" and a warning per conflict.
  - `/settings/resources` (sidebar link): add (name, keywords, tags, file), edit, replace the file (moves "updated", so it wins conflicts), delete (row, index entry and folder).
- **Migrations:** `0015_resources` (`resource`, `resource_fts` and its triggers; `draft.resources` and `draft.conflicts`)
- **Tests (`resources.spec.ts`):**
  - a name match ranks above a tag match; another user's resources never show
  - prefix matching, and at most three results
  - FTS syntax (`"`, `*`, `OR`, `NEAR(`) in the email doesn't break the query
  - unreadable and renamed uploads are refused
  - delete removes the folder and the resource from search; search follows a replaced file
  - a draft sends the matching files, records them, and stores the model's conflict; nothing matching sends nothing
- **Not done:** searching inside the files (decision F), sending only part of a large file, re-ranking with the model. Prefix matching works one way: "price" in an email finds "Prices", but "prices" does not find "Price list".

### Phase 7: Document-aware merging, the "why" panel, logs viewer — done

- **Adds:**
  - Merging drafts that carry documents (the text merge itself shipped in Phase 2). A later draft already builds on the earlier draft's pending file, so the newest file has every change:
    - files of the same document (or filled from the same template) are versions of one file; the newest that rendered is kept, and the older rows and their folders are deleted
    - their change notes are combined, oldest first ("From Notes v2.docx: …"), in the row and in `.changes.md`
    - new documents stand alone, so each distinct one is kept
    - placeholders are listed once per name, so dropping the older versions leaves each field once
  - The model now returns `"intents"` (what the new emails ask for). `draft.intents` stores them; `reason` is now stored on pending drafts too.
  - "Why this draft?" (collapsible, on the draft): reason, intents, whether the thread was cut, resources used.
  - Agent log inside it: the newest 30 runs for the emails the draft covers (agent, time, duration, ok or the error). `agent_run.output` keeps the model's raw reply (up to 20k characters); opening a run fetches it from `/runs/[id]`, which checks the email belongs to the user.
  - `/settings/models` (sidebar link): API key, base URL, model per agent, thread budget (1,000–200,000 tokens). Stored app-wide in `data/settings/models.json`. The key is encrypted with `CREDENTIALS_KEY` and never sent to the browser (only its last 4 characters); a blank field keeps it, Clear removes it. Saved values override `.env`, which overrides the defaults. The base URL must be https (http only for localhost) with no credentials in it.
- **Migrations:** `0016_why_and_logs` (`draft.intents`, `agent_run.output`)
- **Tests:**
  - `document.spec.ts`: a merge keeps only the newest version and deletes the older row and folder, combines the notes, keeps one `[[price]]`, and stores intents; two new documents both stay; runs are listed for a draft's emails and only the owner can read their output
  - `modelSettings.spec.ts`: env and default fallback; the key is encrypted on disk and absent from the page data; a blank key keeps it and Clear falls back to `.env`; the saved base URL, key and per-agent model are used in the request; the budget changes where the thread is cut; bad URLs, budgets and keys are refused
- **Not done:** paging the log past 30 runs; per-user model settings (single-user install); a "test connection" button.

### Phase 8: Searching inside resources, cleanup of server-deleted drafts — done

- **Searching inside resources** (`resourceIndex.ts`):
  - TXT, MD and CSV are read as text. DOCX and XLSX are read locally with `documentText` (the text of the document, headers, footers and notes; the strings in each sheet).
  - PDFs and images are sent to the model (`ingestion` agent) once, through a `resource.index` job, which writes them out as plain text. Each run shows in the agent log as `resource.index`.
  - The text goes into a hidden `resource.content` column (up to 200,000 characters). It is searched, never shown, and never sent to the model with a draft; the file itself still is.
  - FTS5 now covers `content` too, with the lowest bm25 weight (name 10, keywords 5, tags 2, content 1), so a name match still ranks first.
  - Upload and Replace file re-read the file. A DOCX or XLSX that unzips to more than 100 MB is not unpacked.
  - Any failure marks the resource `failed` with the reason. It stays usable and is still found by name, keywords and tags.
  - The resources page shows "Reading the file for search…", "Contents searchable" or the failure, and refreshes while something is pending.
  - On startup, resources still `pending` (including every resource from before this phase) are read. Local files are read at once; PDFs and images are queued once.
- **Server-side deletes (Phase 4 skipped item):** when sync deletes emails (gone from the server, or the folder's UIDVALIDITY changed), it first collects the generated-file folders of drafts on those emails, deletes the emails (rows cascade), then removes the folders. When the server can't say what is gone, nothing is deleted.
- **Migration:** `0017_resource_content` (`resource.content`, `index_status`, `index_error`; `resource_fts` rebuilt with a `content` column and its triggers)
- **Tests:**
  - `resources.spec.ts`: words only inside a DOCX, an XLSX and a CSV are found without a model call; a name match ranks above a content match; a PDF is pending, then read by the job, searchable, and its `updatedAt` unchanged; a failed model call marks it failed and it's still found by name; a zip bomb fails indexing but the upload is kept; startup reads old resources and queues a PDF only once
  - `document.spec.ts`: an email deleted on the server removes its draft's folder and rows; a failed server search keeps them; a renumbered folder removes them
- **Not done:**
  - no sweep for folders orphaned before this phase
  - stored attachment versions are kept when their email is deleted (the other half of decision K)
  - number cells in XLSX are not indexed (only text)
  - a failed read is retried only by replacing the file

## 4. Cleanup

**Done (2026-09-27):**
- Removed `/demo/*`, `/login-01` and `src/lib/vitest-examples`.
- Dropped the `task` table (migration `0006`) and the leftover `draft_attachment`, `draft_reply` and `person_summary` tables in `local.db`.
- `local.db` now records its migrations, so `npm run db:migrate` works from here on.

## 5. Later

- **Email address index.** `listContactEmails` (person page, Rebuild) checks every email in the user's accounts. Fine for one mailbox. When it gets slow, add an `email_address(emailId, address)` table filled at sync time and query it instead.

## 6. Open questions

None open. New questions will be added here as the code raises them.

## 7. To do

- **DOCX → PDF with LibreOffice.** Today a DOCX is sent as a DOCX, and only contracts are rendered to PDF from Markdown. To send a faithful PDF of a Word file instead:
  - LibreOffice is a **separate install** the user does (`winget install TheDocumentFoundation.LibreOffice` or libreoffice.org); npm can't provide it.
  - The app finds `soffice` on the PATH or in its usual install folder, or uses `LIBREOFFICE_PATH` from `.env`.
  - It runs `soffice --headless --convert-to pdf --outdir <folder> <file>`, with a timeout, next to the DOCX.
  - If LibreOffice is missing or the conversion fails, the DOCX is sent as it is, with a note on the draft saying why.
  - This changes decision J ("No LibreOffice"), so it needs the user's go-ahead first.
