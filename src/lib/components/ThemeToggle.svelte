<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import { mode, setMode, userPrefersMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" aria-label="Change theme">
				{#if mode.current === 'dark'}
					<MoonIcon />
				{:else}
					<SunIcon />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content align="end">
		<DropdownMenu.Item onclick={() => setMode('light')}>
			<SunIcon />
			Light
			{#if userPrefersMode.current === 'light'}
				<span class="text-muted-foreground ml-auto text-xs">✓</span>
			{/if}
		</DropdownMenu.Item>

		<DropdownMenu.Item onclick={() => setMode('dark')}>
			<MoonIcon />
			Dark
			{#if userPrefersMode.current === 'dark'}
				<span class="text-muted-foreground ml-auto text-xs">✓</span>
			{/if}
		</DropdownMenu.Item>

		<DropdownMenu.Item onclick={() => setMode('system')}>
			<MonitorIcon />
			System
			{#if userPrefersMode.current === 'system'}
				<span class="text-muted-foreground ml-auto text-xs">✓</span>
			{/if}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
