<script lang="ts">
	import LoginForm from '$lib/components/login-form.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Sign in · Zapoing</title>
</svelte:head>

<div class="bg-muted flex min-h-svh flex-col">
	<header class="flex justify-end p-4">
		<ThemeToggle />
	</header>

	<main class="flex flex-1 items-center justify-center p-6 pb-24 md:p-10">
		<LoginForm message={form?.message} />
	</main>
</div>
