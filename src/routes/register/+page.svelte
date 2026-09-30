<script lang="ts">
	import { enhance } from '$app/forms';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		FieldGroup,
		Field,
		FieldLabel,
		FieldDescription,
		FieldError
	} from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	const id = $props.id();
</script>

<svelte:head>
	<title>Register · Zapoing</title>
</svelte:head>

<div class="bg-muted flex min-h-svh flex-col">
	<header class="flex justify-end p-4">
		<ThemeToggle />
	</header>

	<main class="flex flex-1 items-center justify-center p-6 pb-24 md:p-10">
		<Card.Root class="mx-auto w-full max-w-sm">
			<Card.Header>
				<Card.Title class="text-2xl">Create an account</Card.Title>
				<Card.Description>Enter your details below to create your account</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="post" use:enhance>
					<FieldGroup>
						<Field>
							<FieldLabel for="name-{id}">Name</FieldLabel>
							<Input id="name-{id}" name="name" autocomplete="name" placeholder="Ada Lovelace" />
						</Field>

						<Field>
							<FieldLabel for="email-{id}">Email</FieldLabel>
							<Input
								id="email-{id}"
								name="email"
								type="email"
								autocomplete="email"
								placeholder="m@example.com"
								required
							/>
						</Field>

						<Field>
							<FieldLabel for="password-{id}">Password</FieldLabel>
							<Input
								id="password-{id}"
								name="password"
								type="password"
								autocomplete="new-password"
								required
							/>
						</Field>

						{#if form?.message}
							<FieldError>{form.message}</FieldError>
						{/if}

						<Field>
							<Button type="submit" class="w-full">Create account</Button>

							<FieldDescription class="text-center">
								Already have an account? <a href="/" class="underline">Login</a>
							</FieldDescription>
						</Field>
					</FieldGroup>
				</form>
			</Card.Content>
		</Card.Root>
	</main>
</div>
