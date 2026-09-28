<script lang="ts">
	import { enhance } from '$app/forms';
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

	let { message }: { message?: string } = $props();

	const id = $props.id();

	let mode = $state<'signIn' | 'signUp'>('signIn');

	function showSignIn() {
		mode = 'signIn';
	}

	function showSignUp() {
		mode = 'signUp';
	}

	let title = $derived.by(() => {
		if (mode === 'signUp') {
			return 'Create an account';
		}

		return 'Login';
	});

	let description = $derived.by(() => {
		if (mode === 'signUp') {
			return 'Enter your details below to create your account';
		}

		return 'Enter your email below to login to your account';
	});

	let passwordAutocomplete = $derived.by(() => {
		if (mode === 'signUp') {
			return 'new-password' as const;
		}

		return 'current-password' as const;
	});
</script>

<Card.Root class="mx-auto w-full max-w-sm">
	<Card.Header>
		<Card.Title class="text-2xl">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content>
		<form method="post" action="?/{mode}" use:enhance>
			<FieldGroup>
				{#if mode === 'signUp'}
					<Field>
						<FieldLabel for="name-{id}">Name</FieldLabel>
						<Input id="name-{id}" name="name" autocomplete="name" placeholder="Ada Lovelace" />
					</Field>
				{/if}

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
						autocomplete={passwordAutocomplete}
						required
					/>
				</Field>

				{#if message}
					<FieldError>{message}</FieldError>
				{/if}

				<Field>
					<Button type="submit" class="w-full">
						{#if mode === 'signUp'}
							Create account
						{:else}
							Login
						{/if}
					</Button>

					<FieldDescription class="text-center">
						{#if mode === 'signUp'}
							Already have an account?
							<button type="button" class="underline" onclick={showSignIn}>Login</button>
						{:else}
							Don't have an account?
							<button type="button" class="underline" onclick={showSignUp}>Sign up</button>
						{/if}
					</FieldDescription>
				</Field>
			</FieldGroup>
		</form>
	</Card.Content>
</Card.Root>
