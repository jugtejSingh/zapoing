<script lang="ts">
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar';
	import { Badge } from '$lib/components/ui/badge';
	import { Separator } from '$lib/components/ui/separator';
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { formatDate, formatSize } from '$lib/format';
	import type { CachedEmail } from '$lib/types';

	let { email, open = false }: { email: CachedEmail; open?: boolean } = $props();

	let subject = $derived.by(() => {
		if (email.subject.length === 0) {
			return '(no subject)';
		}

		return email.subject;
	});

	// ponytail: sanitise in the browser, where DOMPurify needs no jsdom. The
	// sandboxed iframe is the real boundary; this just keeps the markup tame.
	let safeHtml = $derived.by(() => {
		if (!browser || !email.html) {
			return null;
		}

		return DOMPurify.sanitize(email.html);
	});

	let srcdoc = $derived.by(() => {
		if (!safeHtml) {
			return null;
		}

		const csp =
			"default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:";

		return (
			'<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' +
			csp +
			'"><style>body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;color:#111;background:#fff;word-break:break-word}img{max-width:100%;height:auto}</style></head><body>' +
			safeHtml +
			'</body></html>'
		);
	});

	let preview = $derived(email.text.replace(/s+/g, ' ').trim().slice(0, 120));

	let initial = $derived.by(() => {
		const match = email.from.match(/[a-zA-Z]/);

		if (!match) {
			return '?';
		}

		return match[0].toUpperCase();
	});
</script>

<!-- ponytail: <details> so collapsing costs no state and no component library. -->
<details {open} class="group border-b last:border-b-0">
	<summary class="hover:bg-muted/50 flex cursor-pointer items-start gap-4 p-4 marker:content-['']">
		<Avatar>
			<AvatarFallback>{initial}</AvatarFallback>
		</Avatar>

		<div class="grid min-w-0 gap-1 text-sm">
			<div class="truncate font-semibold">{email.from}</div>
			<div class="text-muted-foreground line-clamp-1 text-xs group-open:hidden">
				{preview}
			</div>
			<div class="text-muted-foreground line-clamp-1 hidden text-xs group-open:block">
				To: {email.to}
			</div>
		</div>

		<div class="ms-auto flex shrink-0 items-center gap-2">
			<span class="text-muted-foreground text-xs">{formatDate(email.date)}</span>
			<ChevronDownIcon class="text-muted-foreground size-4 group-open:rotate-180" />
		</div>
	</summary>

	<Separator />

	{#if email.attachments.length > 0}
		<div class="flex flex-wrap gap-2 p-4">
			{#each email.attachments as attachment, index (index)}
				<Badge
					variant="outline"
					class="hover:bg-muted gap-1"
					href={resolve('/attachments/[emailId]/[index]', { emailId: email.id, index: String(index) })}
					title="Download"
				>
					<PaperclipIcon class="size-3" />
					{attachment.filename}
					<span class="text-muted-foreground">({formatSize(attachment.size)})</span>
				</Badge>
			{/each}
		</div>

		<Separator />
	{/if}

	{#if srcdoc}
		<!-- ponytail: fixed height, since a sandboxed iframe cannot report its own.
		     Measure it with a postMessage handshake if the scroll-in-scroll grates. -->
		<iframe
			title={subject}
			{srcdoc}
			sandbox=""
			referrerpolicy="no-referrer"
			class="h-[60vh] w-full border-0 bg-white"
		></iframe>
	{:else}
		<pre
			class="p-4 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">{email.text}</pre>
	{/if}
</details>
