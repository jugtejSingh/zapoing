<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Separator } from '$lib/components/ui/separator';
	import TrackedPeopleSection from '$lib/components/TrackedPeopleSection.svelte';
	import type { SafeMailAccount } from '$lib/server/mailAccount';
	import type { TrackedPerson } from '$lib/server/trackedPerson';

	let {
		accounts,
		trackedPeople,
		open = $bindable()
	}: { accounts: SafeMailAccount[]; trackedPeople: TrackedPerson[]; open: boolean } = $props();

	let saving = $state(false);

	// The action lives on /home, so posting works from the message routes too.
	function submitAccount() {
		saving = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			saving = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not connect that mailbox');
				return;
			}

			if (result.type === 'success') {
				toast.success('Mailbox connected');
				open = false;
				await invalidateAll();
			}
		};
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Mailboxes</Dialog.Title>
			<Dialog.Description>Connect an IMAP account to read its mail here.</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-4 overflow-y-auto">
			{#if accounts.length > 0}
				<ul class="grid gap-2">
					{#each accounts as account (account.id)}
						<li class="flex items-center gap-2 text-sm">
							<InboxIcon class="text-muted-foreground size-4 shrink-0" />
							<span class="truncate">{account.label ?? account.username}</span>
							<span class="text-muted-foreground ml-auto shrink-0 text-xs">
								{account.host}:{account.port}
							</span>
						</li>
					{/each}
				</ul>

				<Separator />
			{/if}

			<form method="post" action="/home?/addAccount" use:enhance={submitAccount} class="grid gap-4">
				<div class="grid gap-2">
					<Label for="label">Label</Label>
					<Input id="label" name="label" placeholder="Work" />
				</div>

				<div class="grid gap-2">
					<Label for="username">Email address</Label>
					<Input id="username" name="username" type="email" placeholder="you@gmail.com" required />
				</div>

				<div class="grid gap-2">
					<Label for="password">App password</Label>
					<Input id="password" name="password" type="password" autocomplete="off" required />
				</div>

				<div class="grid grid-cols-[1fr_6rem] gap-3">
					<div class="grid gap-2">
						<Label for="host">IMAP host</Label>
						<Input id="host" name="host" value="imap.gmail.com" required />
					</div>

					<div class="grid gap-2">
						<Label for="port">Port</Label>
						<Input id="port" name="port" type="number" value="993" required />
					</div>
				</div>

				<div class="grid grid-cols-[1fr_6rem] gap-3">
					<div class="grid gap-2">
						<Label for="smtpHost">SMTP host</Label>
						<Input id="smtpHost" name="smtpHost" value="smtp.gmail.com" />
					</div>

					<div class="grid gap-2">
						<Label for="smtpPort">Port</Label>
						<Input id="smtpPort" name="smtpPort" type="number" value="465" />
					</div>
				</div>

				<p class="text-muted-foreground text-xs leading-relaxed">
					Gmail rejects your normal password over IMAP. Turn on 2-Step Verification, then create a
					16-character
					<a
						href="https://myaccount.google.com/apppasswords"
						target="_blank"
						rel="noreferrer"
						class="text-foreground underline"
					>
						App Password
					</a>
					and paste it above.
				</p>

				<Dialog.Footer>
					<Button type="submit" disabled={saving}>
						{#if saving}
							Connecting…
						{:else}
							Connect mailbox
						{/if}
					</Button>
				</Dialog.Footer>
			</form>

			<Separator />

			<TrackedPeopleSection {trackedPeople} />
		</div>
	</Dialog.Content>
</Dialog.Root>
