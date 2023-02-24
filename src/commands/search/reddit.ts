import { LanguageKeys } from '#lib/i18n/LanguageKeys';
import { spoiler } from '@discordjs/builders';
import { Collection } from '@discordjs/collection';
import { Time } from '@sapphire/duration';
import { err, ok, type Result } from '@sapphire/result';
import { isNullish, isNullishOrEmpty } from '@sapphire/utilities';
import { Command, RegisterCommand, type MakeArguments, type MessageResponseOptions } from '@skyra/http-framework';
import { applyLocalizedBuilder, resolveKey, resolveUserKey, type TypedT } from '@skyra/http-framework-i18n';
import { gray, red } from '@skyra/logger';
import { isAbortError, Json, safeTimedFetch, type FetchError } from '@skyra/safe-fetch';
import { MessageFlags } from 'discord-api-types/v10';
import he from 'he';

@RegisterCommand((builder) =>
	applyLocalizedBuilder(builder, LanguageKeys.Commands.Reddit.RootName, LanguageKeys.Commands.Reddit.RootDescription).addStringOption((builder) =>
		applyLocalizedBuilder(builder, LanguageKeys.Commands.Reddit.OptionsReddit).setMinLength(3).setMaxLength(24).setRequired(true)
	)
)
export class UserCommand extends Command {
	private readonly cache = new Collection<string, CacheHit>();
	private readonly forbidden = new Collection<string, { type: ForbiddenType; reason: string }>();

	public override async chatInputRun(interaction: Command.ChatInputInteraction, args: Options) {
		const name = UserCommand.SubRedditNameRegExp.exec(args.reddit.toLowerCase())?.[1];
		if (isNullish(name)) {
			const content = resolveUserKey(interaction, LanguageKeys.Commands.Reddit.InvalidName);
			return interaction.reply({ content, flags: MessageFlags.Ephemeral });
		}

		const forbidden = this.getGatedMessage(interaction, name);
		if (!isNullish(forbidden)) {
			return interaction.reply({ content: forbidden, flags: MessageFlags.Ephemeral });
		}

		const response = await this.fetch(name);
		const body = await response.match({
			ok: (result) => this.handleOk(interaction, result),
			err: (error) => this.handleError(interaction, name, error)
		});
		return interaction.reply(body);
	}

	private async handleOk(interaction: Command.ChatInputInteraction, result: CacheHit): Promise<MessageResponseOptions> {
		const response = await this.handleOkGetContent(interaction, result);
		return response.match({
			ok: (post) => ({ content: resolveKey(interaction, LanguageKeys.Commands.Reddit.Post, post), allowed_mentions: { roles: [], users: [] } }),
			err: (key) => ({ content: resolveUserKey(interaction, key), flags: MessageFlags.Ephemeral })
		});
	}

	private async handleOkGetContent(interaction: Command.ChatInputInteraction, result: CacheHit): Promise<Result<CacheEntry, TypedT>> {
		if (result.posts.length === 0) {
			return err(result.hasNsfl ? LanguageKeys.Commands.Reddit.AllNsfl : LanguageKeys.Commands.Reddit.NoPosts);
		}

		let { posts } = result;
		if (result.hasNsfw) {
			const response = await interaction.fetchChannel();
			if (response.isErr()) return err(LanguageKeys.Commands.Reddit.NsfwFailedToFetchChannel);

			if (response.isOkAnd((channel) => Reflect.get(channel, 'nsfw') !== true)) {
				posts = posts.filter((post) => !post.nsfw);
			}
		}

		return posts.length === 0 ? err(LanguageKeys.Commands.Reddit.AllNsfw) : ok(posts[Math.floor(Math.random() * posts.length)]);
	}

	private handleError(interaction: Command.ChatInputInteraction, reddit: string, error: FetchError): MessageResponseOptions {
		return { content: this.handleErrorGetContent(interaction, reddit, error), flags: MessageFlags.Ephemeral };
	}

	private handleErrorGetContent(interaction: Command.ChatInputInteraction, reddit: string, error: FetchError) {
		if (isAbortError(error)) return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.AbortError);

		const parsed = error.jsonBody as RedditError;
		switch (parsed.error) {
			case 403: {
				if (parsed.reason === 'private') return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorPrivate);
				if (parsed.reason === 'quarantined') {
					const reason = this.forbid(reddit, ForbiddenType.Quarantined, parsed.quarantine_message);
					return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorQuarantined, { reason });
				}
				if (parsed.reason === 'gated') {
					const reason = this.forbid(reddit, ForbiddenType.Quarantined, parsed.interstitial_warning_message);
					return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorGated, { reason });
				}
				break;
			}
			case 404: {
				if (!Reflect.has(parsed, 'reason')) {
					return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorNotFound);
				}
				if (Reflect.get(parsed, 'reason') === 'banned') {
					return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorBanned);
				}
				break;
			}
			case 451: {
				// TODO: Find out the other keys
				this.container.logger.error('[REDDIT] 451', parsed);
				return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableForLegalReasons);
			}
			case 500: {
				return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.Unavailable);
			}
		}

		this.container.logger.error('[Reddit] Unknown Error', parsed);
		return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnknownError);
	}

	private forbid(reddit: string, type: ForbiddenType, reason: string) {
		// Some messages send with 2 empty lines, where some *may* contain an empty whitespace.
		reason = reason.replaceAll(/(?:\s*\n){3,}/g, '\n\n');
		this.container.logger.info(`[REDDIT] Forbidding ${red(reddit)}. Reason: ${gray(reason.replaceAll('\n', '\\n'))}`);
		this.forbidden.set(reddit, { type, reason });
		return reason;
	}

	private async fetch(name: string) {
		const existing = this.cache.get(name);
		if (!isNullish(existing)) return ok(existing);

		const url = `https://www.reddit.com/r/${name}/.json?limit=30`;
		const result = await Json<RedditResponse>(safeTimedFetch(url, 2000));
		return result.map((response) => this.handleResponse(name, response));
	}

	private handleResponse(name: string, response: RedditResponse): CacheHit {
		if (isNullishOrEmpty(response.kind) || isNullish(response.data)) return UserCommand.Invalid;
		if (isNullishOrEmpty(response.data.children)) return UserCommand.Invalid;

		const posts = [] as CacheEntry[];
		let hasNsfl = false;
		let hasNsfw = false;
		for (const child of response.data.children) {
			if (child.kind !== Kind.Post || child.data.hidden || child.data.quarantine) continue;
			if (UserCommand.SubRedditTitleBlockList.test(child.data.title)) {
				hasNsfl = true;
				continue;
			}
			if (child.data.over_18) hasNsfw = true;
			posts.push({
				title: he.decode(child.data.title),
				author: child.data.author,
				url: child.data.spoiler ? spoiler(child.data.url) : child.data.url,
				nsfw: child.data.over_18
			});
		}

		const entry = { hasNsfw, hasNsfl, posts } satisfies CacheHit;
		this.cache.set(name, entry);
		setTimeout(() => this.cache.delete(name), Time.Minute * 5).unref();
		return entry;
	}

	private getGatedMessage(interaction: Command.ChatInputInteraction, name: string) {
		if (UserCommand.SubRedditBlockList.includes(name)) {
			return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.Banned);
		}

		const entry = this.forbidden.get(name);
		if (isNullish(entry)) return null;

		switch (entry.type) {
			case ForbiddenType.Quarantined:
				return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorQuarantined, { reason: entry.reason });
			case ForbiddenType.Gated:
				return resolveUserKey(interaction, LanguageKeys.Commands.Reddit.UnavailableErrorGated, { reason: entry.reason });
		}
	}

	private static readonly SubRedditBlockList = ['nsfl', 'morbidreality', 'watchpeopledie', 'fiftyfifty', 'stikk'];
	private static readonly SubRedditTitleBlockList = /nsfl/i;
	/**
	 * @see {@link https://github.com/reddit-archive/reddit/blob/753b17407e9a9dca09558526805922de24133d53/r2/r2/models/subreddit.py#L392-L408}
	 * @see {@link https://github.com/reddit-archive/reddit/blob/753b17407e9a9dca09558526805922de24133d53/r2/r2/models/subreddit.py#L114}
	 */
	private static readonly SubRedditNameRegExp = /^(?:\/?r\/)?([a-z0-9][a-z0-9_]{2,20})$/;
	private static readonly Invalid = { hasNsfw: false, hasNsfl: false, posts: [] } satisfies CacheHit;
}

type Options = MakeArguments<{
	reddit: 'string';
}>;

enum ForbiddenType {
	Quarantined,
	Gated
}

interface CacheHit {
	readonly hasNsfw: boolean;
	readonly hasNsfl: boolean;
	readonly posts: readonly CacheEntry[];
}

interface CacheEntry {
	readonly title: string;
	readonly author: string;
	readonly url: string;
	readonly nsfw: boolean;
}

type RedditError =
	| RedditNotFound
	| RedditBanned
	| RedditForbidden
	| RedditQuarantined
	| RedditGated
	| RedditUnavailableForLegalReasons
	| RedditServerError;

interface RedditForbidden {
	reason: 'private';
	message: 'Forbidden';
	error: 403;
}

interface RedditQuarantined {
	reason: 'quarantined';
	quarantine_message_html: string;
	message: 'Forbidden';
	quarantine_message: string;
	error: 403;
}

interface RedditGated {
	reason: 'gated';
	interstitial_warning_message_html: string;
	message: 'Forbidden';
	interstitial_warning_message: string;
	error: 403;
}

interface RedditNotFound {
	message: 'Not Found';
	error: 404;
}

interface RedditBanned {
	reason: 'banned';
	message: 'Not Found';
	error: 404;
}

interface RedditUnavailableForLegalReasons {
	// TODO: Find out other keys
	error: 451;
}

interface RedditServerError {
	message: 'Internal Server Error';
	error: 500;
}

interface RedditResponse {
	kind: string;
	data: Data;
}

interface Data {
	after: string;
	before: null;
	children: Child[];
	dist: number;
	modhash: string;
}

interface Child {
	kind: Kind;
	data: PostDataElement;
}

interface PostDataElement {
	all_awardings: any[];
	allow_live_comments: boolean;
	approved_at_utc: null;
	approved_by: null;
	archived: boolean;
	author: string;
	author_flair_background_color: string | null;
	author_flair_css_class: string | null;
	author_flair_richtext: FlairRichtext[];
	author_flair_template_id: string | null;
	author_flair_text: string | null;
	author_flair_text_color: FlairTextColor | null;
	author_flair_type: FlairType;
	author_fullname: string;
	author_patreon_flair: boolean;
	author_premium: boolean;
	awarders: unknown[];
	banned_at_utc: null;
	banned_by: null;
	can_gild: boolean;
	can_mod_post: boolean;
	category: null;
	clicked: boolean;
	content_categories: null;
	contest_mode: boolean;
	created: number;
	created_utc: number;
	discussion_type: null;
	distinguished: null | string;
	domain: string;
	downs: number;
	edited: boolean;
	gilded: number;
	gildings: object;
	hidden: boolean;
	hide_score: boolean;
	id: string;
	is_crosspostable: boolean;
	is_meta: boolean;
	is_original_content: boolean;
	is_reddit_media_domain: boolean;
	is_robot_indexable: boolean;
	is_self: boolean;
	is_video: boolean;
	likes: null;
	link_flair_background_color: string;
	link_flair_css_class: null;
	link_flair_richtext: FlairRichtext[];
	link_flair_template_id: string;
	link_flair_text: null;
	link_flair_text_color: FlairTextColor;
	link_flair_type: FlairType;
	locked: boolean;
	media: null;
	media_embed: object;
	media_only: boolean;
	mod_note: null;
	mod_reason_by: null;
	mod_reason_title: null;
	mod_reports: unknown[];
	name: string;
	no_follow: boolean;
	num_comments: number;
	num_crossposts: number;
	num_reports: null;
	over_18: boolean;
	parent_whitelist_status: null | string;
	permalink: string;
	pinned: boolean;
	post_hint: PostHint;
	preview: Preview;
	pwls: number | null;
	quarantine: boolean;
	removal_reason: null;
	removed_by: null;
	removed_by_category: string;
	report_reasons: null;
	saved: boolean;
	score: number;
	secure_media: null;
	secure_media_embed: object;
	selftext: string;
	selftext_html: null;
	send_replies: boolean;
	spoiler: boolean;
	stickied: boolean;
	subreddit: string;
	subreddit_id: string;
	subreddit_name_prefixed: string;
	subreddit_subscribers: number;
	subreddit_type: SubredditType;
	suggested_sort: null;
	thumbnail: string;
	thumbnail_height: number;
	thumbnail_width: number;
	title: string;
	top_awarded_type: null;
	total_awards_received: number;
	treatment_tags: unknown[];
	ups: number;
	upvote_ratio: number;
	url: string;
	url_overridden_by_dest: string;
	user_reports: unknown[];
	view_count: null;
	visited: boolean;
	whitelist_status: null | string;
	wls: number | null;
}

interface FlairRichtext {
	e: FlairType;
	t: string;
}

enum FlairType {
	Richtext = 'richtext',
	Text = 'text'
}

enum FlairTextColor {
	Dark = 'dark'
}

enum PostHint {
	Link = 'link'
}

interface Preview {
	images: Image[];
	enabled: boolean;
}

interface Image {
	source: Source;
	resolutions: Source[];
	variants: object;
	id: string;
}

interface Source {
	url: string;
	width: number;
	height: number;
}

enum SubredditType {
	Public = 'public',
	Restricted = 'restricted'
}

enum Kind {
	Post = 't3',
	Reddit = 't5'
}
