/**
 * Option groups in `--help`, backported from commander 14.
 *
 * `vectorize` declares 56 options. Rendered as one flat list in declaration
 * order, `--adaptive-t` sits between `--adaptive-window` and `--stroke-width`,
 * and the embed strategy lands after the verification flags — so the page is
 * exhaustive and unreadable at the same time, which is the worst combination
 * for the command people reach for first.
 *
 * Commander gained `Command#optionsGroup` and `Option#helpGroup` in 14.0.0.
 * This package is pinned to 12.1.0 because 14 raises the Node floor from 18.17
 * to 20, which is not a change to make for a help page.
 *
 * So this is a **polyfill, not a workaround**: the two methods carry commander
 * 14's names and semantics exactly, so every call site here is already written
 * in the vocabulary of the version we will eventually install. Upgrading means
 * deleting this file and changing nothing else — which is the property that
 * distinguishes a polyfill from a hack, and the reason it was worth doing this
 * way rather than inventing a local API.
 *
 * The one thing it must own is `formatHelp`. Two lighter-touch approaches were
 * tried and both are worse:
 *
 *   - Injecting heading rows into `visibleOptions` corrupts the column width.
 *     `padWidth` measures every entry it returns, so a heading longer than the
 *     longest flag pushes every description right — including in the Arguments
 *     section, which shares the same width.
 *   - Emptying `visibleOptions` and printing the list through `addHelpText`
 *     silently kills commander's did-you-mean suggestions, because
 *     `unknownOption` reads `visibleOptions` directly. Losing "(Did you mean
 *     --palette?)" on a 56-option command is a real regression precisely where
 *     the suggestion is most useful.
 *
 * `formatHelp` below is commander's own body with the Options block replaced.
 * Everything else — usage, description, arguments, subcommands with their
 * aliases, global options, wrapping, terminal width — is delegated to the
 * helper unchanged. Verified byte-identical to stock output on commands that
 * declare no groups.
 */
import { Command, Help, Option } from 'commander';

/** Where a group heading begins, as an index into the command's option list. */
interface GroupMark {
  at: number;
  heading: string;
}

const marks = new WeakMap<Command, GroupMark[]>();
const headings = new WeakMap<Option, string>();

declare module 'commander' {
  interface Command {
    /** Heading for options added after this call. Commander 14's `optionsGroup`. */
    optionsGroup(heading: string): this;
  }
  interface Option {
    /** Heading for this option, overriding the ambient group. Commander 14's `helpGroup`. */
    helpGroup(heading: string): this;
  }
}

Command.prototype.optionsGroup = function optionsGroup(this: Command, heading: string): Command {
  const list = marks.get(this) ?? [];
  // Watermark the current length: everything added from here belongs to this
  // heading, which is exactly how commander 14 defines it.
  list.push({ at: this.options.length, heading });
  marks.set(this, list);
  return this;
};

Option.prototype.helpGroup = function helpGroup(this: Option, heading: string): Option {
  headings.set(this, heading);
  return this;
};

/** The heading an option belongs to, or null when it is ungrouped. */
function groupOf(cmd: Command, option: Option, index: number): string | null {
  const explicit = headings.get(option);
  if (explicit !== undefined) return explicit;
  // `--help` is synthesised by commander and appended after everything the
  // command declared, so a positional rule hands it whichever group happened to
  // be open last — which is how it ended up filed under "Output and document".
  // It belongs to no group; it is the one option every command has.
  if (!cmd.options.includes(option)) return null;
  const list = marks.get(cmd);
  if (!list?.length) return null;
  let heading: string | null = null;
  for (const mark of list) {
    if (mark.at <= index) heading = mark.heading;
    else break;
  }
  return heading;
}

/**
 * Commander's `formatHelp`, with grouped options.
 *
 * Kept structurally identical to the original so the two can be diffed when
 * commander changes. The only edit is the Options section.
 */
function formatHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth ?? 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  const formatItem = (term: string, description: string): string => {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  };
  const formatList = (textArray: string[]): string =>
    textArray.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));

  let output: string[] = [`Usage: ${helper.commandUsage(cmd)}`, ''];

  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat([helper.wrap(commandDescription, helpWidth, 0), '']);
  }

  const argumentList = helper.visibleArguments(cmd).map((argument) =>
    formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument)));
  if (argumentList.length > 0) {
    output = output.concat(['Arguments:', formatList(argumentList), '']);
  }

  // --- the only section that differs from commander's own body ---
  //
  // Insertion order is preserved rather than sorted: the groups read in the
  // order the command declares them, which is the order someone reading the
  // source already has in their head. Ungrouped options keep the plain
  // "Options:" heading and come last, so a command that declares no groups at
  // all renders exactly as it did before.
  const visible = helper.visibleOptions(cmd);
  const buckets = new Map<string, string[]>();
  const ungrouped: string[] = [];
  visible.forEach((option, index) => {
    const item = formatItem(helper.optionTerm(option), helper.optionDescription(option));
    const heading = groupOf(cmd, option, index);
    if (heading === null) {
      ungrouped.push(item);
      return;
    }
    const bucket = buckets.get(heading);
    if (bucket) bucket.push(item);
    else buckets.set(heading, [item]);
  });
  for (const [heading, items] of buckets) {
    output = output.concat([heading, formatList(items), '']);
  }
  if (ungrouped.length > 0) {
    output = output.concat(['Options:', formatList(ungrouped), '']);
  }
  // --- end of the edit ---

  if (helper.showGlobalOptions) {
    const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) =>
      formatItem(helper.optionTerm(option), helper.optionDescription(option)));
    if (globalOptionList.length > 0) {
      output = output.concat(['Global Options:', formatList(globalOptionList), '']);
    }
  }

  const commandList = helper.visibleCommands(cmd).map((sub) =>
    formatItem(helper.subcommandTerm(sub), helper.subcommandDescription(sub)));
  if (commandList.length > 0) {
    output = output.concat(['Commands:', formatList(commandList), '']);
  }

  return output.join('\n');
}

/**
 * Install grouped help on a program and everything under it.
 *
 * `configureHelp` is copied to subcommands as they are created, so calling this
 * on the root before declaring commands covers all of them.
 */
export function installGroupedHelp(program: Command): void {
  program.configureHelp({ formatHelp: formatHelp as Help['formatHelp'] });
}
