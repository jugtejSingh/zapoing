<script lang="ts">
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import FormField from '$lib/components/FormField.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let saving = $state(false);

	function submitSave() {
		saving = true;

		return async ({ result, update }: { result: { type: string }; update: (options?: { reset?: boolean }) => Promise<void> }) => {
			saving = false;

			if (result.type === 'success') {
				toast.success('Profile saved');
			} else {
				toast.error('Could not save the profile');
			}

			await update({ reset: false });
		};
	}

	/** The logo forms are separate from the profile form, so saving one never touches the other. */
	function submitLogo() {
		return async ({ result, update }: { result: { type: string; data?: { message?: string } }; update: () => Promise<void> }) => {
			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not save the logo');
				return;
			}

			toast.success('Logo updated');
			await update();
		};
	}
</script>

<svelte:head>
	<title>Profile · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold">Your profile</h1>
		<a href="/home" class="text-muted-foreground text-sm hover:underline">Back to inbox</a>
	</div>

	<form method="post" action="?/save" use:enhance={submitSave} class="grid gap-4">
		<FormField name="name" label="Name" value={data.profile.name} />
		<FormField name="role" label="Role" value={data.profile.role} />
		<FormField name="company" label="Company" value={data.profile.company} />
		<FormField
			name="companyDescription"
			label="What the company does"
			value={data.profile.companyDescription}
			multiline
		/>
		<FormField name="signOff" label="Sign-off" value={data.profile.signOff} hint="e.g. Best, / Cheers," />
		<FormField name="signature" label="Signature" value={data.profile.signature} multiline />
		<FormField name="tone" label="Tone" value={data.profile.writingStyle.tone} hint="e.g. warm, direct" />
		<FormField name="length" label="Length" value={data.profile.writingStyle.length} hint="e.g. short, 3-5 sentences" />
		<FormField
			name="phrasesUse"
			label="Phrases you use"
			value={data.profile.writingStyle.phrasesUse.join('\n')}
			hint="One per line"
			multiline
		/>
		<FormField
			name="phrasesAvoid"
			label="Phrases to avoid"
			value={data.profile.writingStyle.phrasesAvoid.join('\n')}
			hint="One per line"
			multiline
		/>
		<FormField name="timezone" label="Timezone" value={data.profile.timezone} hint="e.g. Europe/London" />
		<FormField name="workingHours" label="Working hours" value={data.profile.workingHours} hint="e.g. Mon-Fri 9:00-17:30" />
		<FormField
			name="standingRules"
			label="Standing rules"
			value={data.profile.standingRules.join('\n')}
			hint="One per line, e.g. Never commit to a date without checking with me"
			multiline
		/>

		<h2 class="pt-2 text-base font-semibold">Documents</h2>
		<p class="text-muted-foreground -mt-2 text-xs">
			Applied to the documents the AI writes. Leave a field empty to leave it out.
		</p>
		<FormField name="font" label="Font" value={data.profile.branding.font} hint="e.g. Calibri. It must be installed on this computer" />
		<FormField name="primaryColor" label="Colour" value={data.profile.branding.primaryColor} hint="Hex, e.g. #1a4d8f. Used for headings" />
		<FormField name="headerText" label="Header" value={data.profile.branding.headerText} hint="Next to the logo, at the top of every page" />
		<FormField name="footerText" label="Footer" value={data.profile.branding.footerText} hint="At the bottom of every page" />

		<Button type="submit" disabled={saving} class="justify-self-start">
			{#if saving}
				Saving…
			{:else}
				Save
			{/if}
		</Button>
	</form>

	<div class="grid gap-2">
		<h2 class="text-sm font-medium">Logo</h2>
		<form
			method="post"
			action="?/logo"
			enctype="multipart/form-data"
			use:enhance={submitLogo}
			class="flex items-center gap-2"
		>
			<input type="file" name="logo" accept="image/png,image/jpeg" class="text-xs" />
			<Button type="submit" size="sm" variant="secondary">Upload</Button>
		</form>
		{#if data.hasLogo}
			<form method="post" action="?/removeLogo" use:enhance={submitLogo} class="flex items-center gap-2">
				<span class="text-muted-foreground text-xs">A logo is set.</span>
				<Button type="submit" size="sm" variant="ghost">Remove</Button>
			</form>
		{/if}
	</div>
</main>
