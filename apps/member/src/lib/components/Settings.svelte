<script lang="ts">
	// Port of apps/web/app/(saas)/app/(account)/settings/* — Svelte 5 island.
	//
	// The original is a Next.js sidebar layout (settings/layout.tsx) wrapping four
	// auth/billing-backed sub-routes (general / security / billing / danger-zone).
	// The Fresh app has no Better Auth or billing backend, so every form here is a
	// faithful STYLED SHELL: real cards/labels/inputs prefilled with the stub user,
	// with all mutating controls (Save / upload / Enable / Delete) DISABLED behind a
	// "sign-in is connected" note. The four sub-pages are rendered as SECTIONS inside
	// this one component, switched by an internal sidebar held in $state — no
	// sub-routes. Stubbed/deferred: useSession, authClient.*, orpc payments,
	// react-hook-form/zod validation, sonner toasts, the cropper avatar upload,
	// and the 2FA QR dialog.

	import {
		type SettingsData,
		SETTINGS_DATA,
	} from "$lib/data/settings-data";

	let { data = SETTINGS_DATA }: { data?: SettingsData } = $props();

	type SectionId = "general" | "security" | "billing" | "danger-zone";

	const NAV: { id: SectionId; title: string }[] = [
		{ id: "general", title: "General" },
		{ id: "security", title: "Security" },
		{ id: "billing", title: "Billing" },
		{ id: "danger-zone", title: "Danger Zone" },
	];

	let active = $state<SectionId>("general");

	// Local form state — purely cosmetic; backend writes are deferred so nothing
	// is persisted. Inputs stay editable so the shells feel real. We intentionally
	// seed each field from the stub user once on mount; later prop changes are not
	// meant to overwrite what the user typed.
	// svelte-ignore state_referenced_locally
	let name = $state(data.user.name);
	// svelte-ignore state_referenced_locally
	let email = $state(data.user.email);
	// svelte-ignore state_referenced_locally
	let notificationEmail = $state(data.user.notificationEmail);
	let currentPassword = $state("");
	let newPassword = $state("");
	let confirmPassword = $state("");

	const DISABLED_NOTE = "Account changes are available once sign-in is connected.";
</script>

{#snippet iconSettings()}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
		<circle cx="12" cy="12" r="3" />
	</svg>
{/snippet}

{#snippet iconLock()}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="12" cy="16" r="1" />
		<rect x="3" y="10" width="18" height="12" rx="2" />
		<path d="M7 10V7a5 5 0 0 1 10 0v3" />
	</svg>
{/snippet}

{#snippet iconCard()}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<rect width="20" height="14" x="2" y="5" rx="2" />
		<line x1="2" x2="22" y1="10" y2="10" />
	</svg>
{/snippet}

{#snippet iconAlert()}
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
		<path d="M12 9v4" />
		<path d="M12 17h.01" />
	</svg>
{/snippet}

{#snippet navIcon(id: SectionId)}
	{#if id === "general"}{@render iconSettings()}
	{:else if id === "security"}{@render iconLock()}
	{:else if id === "billing"}{@render iconCard()}
	{:else}{@render iconAlert()}{/if}
{/snippet}

<div class="root">
	<div class="layout">
		<!-- Left sidebar (stacks horizontally on mobile, vertical column on lg+). -->
		<aside class="sidebar">
			<div class="sidebar__head">
				<span class="avatar">{data.user.initials}</span>
				<h2 class="sidebar__heading">Account</h2>
			</div>
			<ul class="nav">
				{#each NAV as item (item.id)}
					<li>
						<button
							type="button"
							class="nav__item"
							class:active={active === item.id}
							aria-current={active === item.id ? "page" : undefined}
							onclick={() => (active = item.id)}
						>
							<span class="nav__icon">{@render navIcon(item.id)}</span>
							<span>{item.title}</span>
						</button>
					</li>
				{/each}
			</ul>
		</aside>

		<!-- Main content: the active section's shell. -->
		<div class="content">
			{#if active === "general"}
				<!-- Avatar -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Avatar</h3>
							<p class="card__desc">Upload an image for your profile.</p>
							<p class="card__hint">JPG, PNG or GIF. Max 1MB.</p>
						</div>
						<div class="card__body">
							<div class="avatar-row">
								<span class="avatar avatar--lg">{data.user.initials}</span>
								<button type="button" class="btn btn--light" disabled>
									<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M12 3v12" />
										<path d="m17 8-5-5-5 5" />
										<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
									</svg>
									Upload
								</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Change name -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Change name</h3>
						</div>
						<div class="card__body">
							<input class="input" type="text" bind:value={name} />
							<div class="actions">
								<button type="button" class="btn btn--primary" disabled>Save</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Change email -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Change email</h3>
							<p class="card__desc">
								This is the email you use to sign in.
							</p>
						</div>
						<div class="card__body">
							<input class="input" type="email" bind:value={email} />
							<div class="actions">
								<button type="button" class="btn btn--primary" disabled>Save</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Notification email -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Notification email</h3>
							<p class="card__desc">
								Where we send product and billing notifications.
							</p>
						</div>
						<div class="card__body">
							<input
								class="input"
								type="email"
								placeholder={data.user.email}
								bind:value={notificationEmail}
							/>
							<div class="actions">
								<button type="button" class="btn btn--primary" disabled>Save</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>
			{:else if active === "security"}
				<!-- Change password -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Change password</h3>
						</div>
						<div class="card__body">
							<div class="field-stack">
								<div class="field">
									<div class="field__head">
										<label class="label" for="cur-pw">Current password</label>
										<span class="link-muted">Forgot password?</span>
									</div>
									<input id="cur-pw" class="input" type="password" autocomplete="current-password" bind:value={currentPassword} />
								</div>
								<div class="field">
									<label class="label" for="new-pw">New password</label>
									<input id="new-pw" class="input" type="password" autocomplete="new-password" bind:value={newPassword} />
								</div>
								<div class="field">
									<label class="label" for="conf-pw">Confirm new password</label>
									<input id="conf-pw" class="input" type="password" autocomplete="new-password" bind:value={confirmPassword} />
								</div>
							</div>
							<div class="actions">
								<button type="button" class="btn btn--primary" disabled>Save</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Connected accounts -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Connected accounts</h3>
						</div>
						<div class="card__body">
							<div class="rows">
								{#each data.connectedAccounts as acct (acct.provider)}
									<div class="row">
										<div class="row__left">
											{#if acct.provider === "google"}
												<svg class="provider-icon" viewBox="0 0 488 512" fill="currentColor" aria-hidden="true">
													<path d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C258.5 52.6 94.3 116.6 94.3 256c0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z" />
												</svg>
											{:else}
												<svg class="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color:#5865F2">
													<path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.371-.291a.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
												</svg>
											{/if}
											<span class="row__name">{acct.name}</span>
										</div>
										{#if acct.linked}
											<span class="connected">
												<svg class="row__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<circle cx="12" cy="12" r="10" />
													<path d="m9 12 2 2 4-4" />
												</svg>
												Connected
											</span>
										{:else}
											<button type="button" class="btn btn--light btn--sm" disabled>
												<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
													<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
												</svg>
												Connect
											</button>
										{/if}
									</div>
								{/each}
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Passkeys -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Passkeys</h3>
							<p class="card__desc">
								Sign in securely without a password.
							</p>
						</div>
						<div class="card__body">
							<div class="empty-state">
								<svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
									<path d="m21 2-9.6 9.6" />
									<circle cx="7.5" cy="15.5" r="5.5" />
								</svg>
								<span>No passkeys yet.</span>
							</div>
							<div class="actions actions--start">
								<button type="button" class="btn btn--light" disabled>
									<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M5 12h14" />
										<path d="M12 5v14" />
									</svg>
									Add passkey
								</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Two-factor -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Two-factor authentication</h3>
							<p class="card__desc">
								Add an extra layer of security to your account.
							</p>
						</div>
						<div class="card__body">
							<div class="actions actions--start">
								<button type="button" class="btn btn--light" disabled>
									<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
										<path d="m9 12 2 2 4-4" />
									</svg>
									Enable
								</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>

				<!-- Active sessions -->
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Active sessions</h3>
							<p class="card__desc">
								Devices currently signed in to your account.
							</p>
						</div>
						<div class="card__body">
							<div class="rows">
								{#each data.sessions as session (session.id)}
									<div class="row">
										<div class="row__left">
											<svg class="provider-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<rect width="20" height="14" x="2" y="3" rx="2" />
												<line x1="8" x2="16" y1="21" y2="21" />
												<line x1="12" x2="12" y1="17" y2="21" />
											</svg>
											<div class="session__text">
												<strong class="session__device">
													{session.device}
													{#if session.current}<span class="badge">This device</span>{/if}
												</strong>
												<small class="session__meta">{session.lastActive}</small>
											</div>
										</div>
										<button type="button" class="btn btn--light btn--icon" disabled aria-label="Revoke session">
											<svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<path d="M18 6 6 18" />
												<path d="m6 6 12 12" />
											</svg>
										</button>
									</div>
								{/each}
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>
			{:else if active === "billing"}
				<section class="card">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title">Current plan</h3>
						</div>
						<div class="card__body">
							<div class="plan">
								<div class="plan__head">
									<svg class="plan__badge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
										<path d="m9 12 2 2 4-4" />
									</svg>
									<h4 class="plan__name">{data.plan.name}</h4>
									<span class="status-badge status-badge--{data.plan.status}">
										{data.plan.status}
									</span>
								</div>
								<ul class="plan__features">
									{#each data.plan.features as feature (feature)}
										<li>
											<svg class="plan__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<path d="M20 6 9 17l-5-5" />
											</svg>
											<span>{feature}</span>
										</li>
									{/each}
								</ul>
								<strong class="plan__price">{data.plan.price}</strong>
								<p class="plan__renew">Renews on {data.plan.renewsOn}</p>
							</div>
							<div class="actions">
								<button type="button" class="btn btn--primary" disabled>
									Manage subscription
								</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>
			{:else}
				<section class="card card--danger">
					<div class="card__grid">
						<div class="card__meta">
							<h3 class="card__title card__title--danger">Delete account</h3>
							<p class="card__desc">
								Permanently delete your account and all of its data.
							</p>
						</div>
						<div class="card__body">
							<div class="warning">
								<svg class="warning__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
									<path d="M12 9v4" />
									<path d="M12 17h.01" />
								</svg>
								<span>
									This action cannot be undone. Your account will be fully
									removed after a 30-day grace period, along with all
									scrapes, dashboards, and saved content.
								</span>
							</div>
							<div class="actions">
								<button type="button" class="btn btn--destructive" disabled>
									Delete account
								</button>
							</div>
							<p class="note">{DISABLED_NOTE}</p>
						</div>
					</div>
				</section>
			{/if}
		</div>
	</div>
</div>

<style>
	.root {
		--background: #1a1916;
		--foreground: #f2f1ed;
		--card: #232220;
		--card-2: #2b2a27;
		--card-3: #33312e;
		--popover: #232220;
		--primary: #f54e00;
		--primary-foreground: #ffffff;
		--secondary: #24243a;
		--muted: #232220;
		--muted-foreground: rgba(242, 241, 237, 0.6);
		--subtle: rgba(242, 241, 237, 0.42);
		--accent: #aeadad;
		--success: #39a561;
		--warning: #fbbf24;
		--destructive: #ef4444;
		--border: rgba(242, 241, 237, 0.1);
		--border-2: rgba(242, 241, 237, 0.16);
		--ring: #e8650a;
		--radius: 14px;
		--font-serif: "Iowan Old Style", "Georgia", serif;

		color: var(--foreground);
		font-family:
			ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
		font-size: 14px;
		line-height: 1.5;
	}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	.layout {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1rem;
	}

	/* Sidebar */
	.sidebar {
		width: 100%;
	}
	.sidebar__head {
		display: none;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	.sidebar__heading {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	.nav {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
	}
	.nav__item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		white-space: nowrap;
		padding: 0.4rem 0;
		border: none;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--muted-foreground);
		font-size: 14px;
		font-family: inherit;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}
	.nav__item:hover {
		color: var(--foreground);
	}
	.nav__item.active {
		color: var(--foreground);
		font-weight: 700;
		border-bottom-color: var(--primary);
	}
	.nav__icon {
		display: inline-flex;
		opacity: 0.55;
	}
	.nav__icon :global(svg) {
		width: 16px;
		height: 16px;
	}
	.nav__item.active .nav__icon {
		opacity: 1;
		color: var(--primary);
	}

	.content {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* Card */
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 18px;
		padding: 1rem;
	}
	.card--danger {
		border-color: rgba(239, 68, 68, 0.4);
	}
	.card__grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
	}
	.card__meta {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.card__title {
		margin: 0;
		font-weight: 600;
		font-size: 15px;
		line-height: 1.2;
	}
	.card__title--danger {
		color: var(--destructive);
	}
	.card__desc {
		margin: 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.card__hint {
		margin: 0;
		font-size: 12px;
		color: var(--subtle);
	}
	.card__body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}

	/* Avatar */
	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 999px;
		background: var(--card-3);
		color: var(--foreground);
		font-weight: 600;
		font-size: 13px;
		flex-shrink: 0;
	}
	.avatar--lg {
		width: 64px;
		height: 64px;
		font-size: 22px;
	}
	.avatar-row {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	/* Inputs */
	.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: var(--card-2);
		border: 1px solid var(--border-2);
		border-radius: 10px;
		color: var(--foreground);
		font-size: 14px;
		font-family: inherit;
	}
	.input::placeholder {
		color: var(--subtle);
	}
	.input:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 2px rgba(232, 101, 10, 0.25);
	}
	.field-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.field__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.label {
		font-size: 13px;
		font-weight: 500;
		color: var(--foreground);
	}
	.link-muted {
		font-size: 13px;
		color: var(--primary);
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 0.5rem 0.9rem;
		border-radius: 10px;
		border: 1px solid transparent;
		font-size: 14px;
		font-weight: 500;
		font-family: inherit;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn__icon {
		width: 16px;
		height: 16px;
	}
	.btn--primary {
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.btn--light {
		background: var(--card-3);
		color: var(--foreground);
		border-color: var(--border-2);
	}
	.btn--destructive {
		background: var(--destructive);
		color: #ffffff;
	}
	.btn--sm {
		padding: 0.35rem 0.7rem;
		font-size: 13px;
	}
	.btn--icon {
		padding: 0.45rem;
		width: 34px;
		height: 34px;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.actions--start {
		justify-content: flex-start;
	}

	.note {
		margin: 0;
		font-size: 12px;
		color: var(--subtle);
		font-style: italic;
	}

	/* Rows (connected accounts / sessions) */
	.rows {
		display: flex;
		flex-direction: column;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 0;
		border-top: 1px solid var(--border);
	}
	.row:first-child {
		border-top: none;
	}
	.row__left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.provider-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		color: var(--accent);
	}
	.row__name {
		font-size: 14px;
	}
	.connected {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 13px;
		color: var(--success);
	}
	.row__check {
		width: 18px;
		height: 18px;
	}

	.session__text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}
	.session__device {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 14px;
		font-weight: 600;
	}
	.session__meta {
		font-size: 12px;
		color: var(--muted-foreground);
	}
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: rgba(57, 165, 97, 0.15);
		color: var(--success);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 1rem;
		border: 1px dashed var(--border-2);
		border-radius: 12px;
		color: var(--muted-foreground);
		font-size: 13px;
	}
	.empty-state__icon {
		width: 20px;
		height: 20px;
		opacity: 0.6;
	}

	/* Billing plan */
	.plan {
		border: 1px solid var(--border-2);
		border-radius: 14px;
		padding: 1rem;
		background: var(--card-2);
	}
	.plan__head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.plan__badge {
		width: 22px;
		height: 22px;
		color: var(--primary);
	}
	.plan__name {
		margin: 0;
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 18px;
		color: var(--primary);
	}
	.status-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		text-transform: capitalize;
	}
	.status-badge--active {
		background: rgba(57, 165, 97, 0.15);
		color: var(--success);
	}
	.status-badge--trialing {
		background: rgba(251, 191, 36, 0.15);
		color: var(--warning);
	}
	.status-badge--past_due,
	.status-badge--canceled {
		background: rgba(239, 68, 68, 0.15);
		color: var(--destructive);
	}
	.plan__features {
		list-style: none;
		margin: 0.75rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
		font-size: 13px;
	}
	.plan__features li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.plan__check {
		width: 16px;
		height: 16px;
		color: var(--primary);
		flex-shrink: 0;
	}
	.plan__price {
		display: block;
		margin-top: 0.75rem;
		font-weight: 600;
		font-size: 24px;
	}
	.plan__renew {
		margin: 0.25rem 0 0;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	/* Danger warning */
	.warning {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.85rem;
		border: 1px solid rgba(239, 68, 68, 0.35);
		border-radius: 12px;
		background: rgba(239, 68, 68, 0.08);
		font-size: 13px;
		color: rgba(242, 241, 237, 0.8);
	}
	.warning__icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		color: var(--destructive);
		margin-top: 1px;
	}

	/* lg+ : sidebar becomes a sticky left column, cards get a two-column grid. */
	@media (min-width: 1024px) {
		.layout {
			flex-direction: row;
			gap: 2rem;
		}
		.sidebar {
			position: sticky;
			top: 1rem;
			width: 100%;
			max-width: 180px;
		}
		.sidebar__head {
			display: flex;
		}
		.nav {
			flex-direction: column;
			gap: 0.25rem;
		}
		.nav__item {
			border-bottom: none;
			border-left: 2px solid transparent;
			padding: 0.3rem 0 0.3rem 0.5rem;
			margin-left: -2px;
		}
		.nav__item.active {
			border-bottom: none;
			border-left-color: var(--primary);
		}
		.content {
			flex: 1;
		}
		.card {
			padding: 1.5rem;
		}
		.card__grid {
			grid-template-columns: minmax(0, 280px) auto;
			gap: 2rem;
		}
	}
</style>
