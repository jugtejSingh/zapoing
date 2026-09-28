<script lang="ts">
	import FileIcon from '@lucide/svelte/icons/file';
	import { resolve } from '$app/paths';
	import { Badge } from '$lib/components/ui/badge';
	import { formatDate, formatSize } from '$lib/format';
	import type { PersonDocument } from '$lib/types';
	import DocumentMergeForm from './DocumentMergeForm.svelte';

	let { documents }: { documents: PersonDocument[] } = $props();

	function othersThan(keep: PersonDocument): PersonDocument[] {
		const list: PersonDocument[] = [];

		for (const candidate of documents) {
			if (candidate.id !== keep.id) {
				list.push(candidate);
			}
		}

		return list;
	}
</script>

<section class="grid gap-2">
	<h2 class="font-medium">Documents</h2>
	<p class="text-muted-foreground text-xs">
		Files from their mail, grouped into versions. If two entries are the same document, merge them.
	</p>
	{#if documents.length === 0}
		<p class="text-muted-foreground text-sm">No files stored yet.</p>
	{:else}
		<ul class="divide-y rounded-md border">
			{#each documents as document (document.id)}
				<li class="grid gap-2 p-3">
					<div class="flex flex-wrap items-center gap-2">
						<FileIcon class="text-muted-foreground size-4 shrink-0" />
						<span class="truncate text-sm font-medium">{document.name}</span>
						<Badge variant="secondary">v{document.versions.length}</Badge>
						{#if documents.length > 1}
							<div class="ms-auto">
								<DocumentMergeForm keep={document} others={othersThan(document)} />
							</div>
						{/if}
					</div>
					<ul class="grid gap-1 ps-6">
						{#each document.versions as version (version.id)}
							<li>
								<a
									href={resolve('/files/[versionId]', { versionId: version.id })}
									class="hover:bg-muted flex items-center gap-2 rounded px-2 py-1 text-xs"
									title="Download"
								>
									<span class="shrink-0 font-medium">v{version.version}</span>
									<span class="truncate">{version.filename}</span>
									<span class="text-muted-foreground shrink-0">{formatSize(version.size)}</span>
									{#if !version.readable}
										<Badge variant="outline" title="Not a type the AI reads">Not read by AI</Badge>
									{/if}
									<span class="text-muted-foreground ms-auto truncate">{version.sender}</span>
									<span class="text-muted-foreground shrink-0"
										>{formatDate(version.receivedAt)}</span
									>
								</a>
							</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
	{/if}
</section>
