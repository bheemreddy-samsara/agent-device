type AndroidIntentOption = readonly [audience: 'intent' | 'launch', valueCount: 0 | 1 | 2];

/** AOSP Intent.parseCommandArgs and ActivityManagerShellCommand.makeIntent option arities. */
const ANDROID_INTENT_OPTIONS: Readonly<Record<string, AndroidIntentOption>> = {
  '-a': ['intent', 1],
  '-d': ['intent', 1],
  '-t': ['intent', 1],
  '-i': ['intent', 1],
  '-c': ['intent', 1],
  '-n': ['intent', 1],
  '-p': ['intent', 1],
  '-f': ['intent', 1],
  '-e': ['intent', 2],
  '--es': ['intent', 2],
  '--esn': ['intent', 1],
  '--ei': ['intent', 2],
  '--eu': ['intent', 2],
  '--ecn': ['intent', 2],
  '--eia': ['intent', 2],
  '--eial': ['intent', 2],
  '--el': ['intent', 2],
  '--ela': ['intent', 2],
  '--elal': ['intent', 2],
  '--ef': ['intent', 2],
  '--efa': ['intent', 2],
  '--efal': ['intent', 2],
  '--ed': ['intent', 2],
  '--eda': ['intent', 2],
  '--edal': ['intent', 2],
  '--esa': ['intent', 2],
  '--esal': ['intent', 2],
  '--ez': ['intent', 2],
  '--grant-read-uri-permission': ['intent', 0],
  '--grant-write-uri-permission': ['intent', 0],
  '--grant-persistable-uri-permission': ['intent', 0],
  '--grant-prefix-uri-permission': ['intent', 0],
  '--exclude-stopped-packages': ['intent', 0],
  '--include-stopped-packages': ['intent', 0],
  '--debug-log-resolution': ['intent', 0],
  '--activity-brought-to-front': ['intent', 0],
  '--activity-clear-top': ['intent', 0],
  '--activity-clear-when-task-reset': ['intent', 0],
  '--activity-exclude-from-recents': ['intent', 0],
  '--activity-launched-from-history': ['intent', 0],
  '--activity-multiple-task': ['intent', 0],
  '--activity-no-animation': ['intent', 0],
  '--activity-no-history': ['intent', 0],
  '--activity-no-user-action': ['intent', 0],
  '--activity-previous-is-top': ['intent', 0],
  '--activity-reorder-to-front': ['intent', 0],
  '--activity-reset-task-if-needed': ['intent', 0],
  '--activity-single-top': ['intent', 0],
  '--activity-clear-task': ['intent', 0],
  '--activity-task-on-home': ['intent', 0],
  '--activity-match-external': ['intent', 0],
  '--receiver-registered-only': ['intent', 0],
  '--receiver-replace-pending': ['intent', 0],
  '--receiver-foreground': ['intent', 0],
  '--receiver-no-abort': ['intent', 0],
  '--receiver-include-background': ['intent', 0],
  '--selector': ['intent', 0],
  '--user': ['intent', 1],
  '-D': ['launch', 0],
  '--suspend': ['launch', 0],
  '-N': ['launch', 0],
  '-W': ['launch', 0],
  '-P': ['launch', 1],
  '--start-profiler': ['launch', 1],
  '--sampling': ['launch', 1],
  '--clock-type': ['launch', 1],
  '--profiler-output-version': ['launch', 1],
  '--streaming': ['launch', 0],
  '--attach-agent': ['launch', 1],
  '--attach-agent-bind': ['launch', 1],
  '-R': ['launch', 1],
  '-S': ['launch', 0],
  '--track-allocation': ['launch', 0],
  '--receiver-permission': ['launch', 1],
  '--display': ['launch', 1],
  '--task-display-area-feature-id': ['launch', 1],
  '--windowingMode': ['launch', 1],
  '--activityType': ['launch', 1],
  '--task': ['launch', 1],
  '--task-overlay': ['launch', 0],
  '--lock-task': ['launch', 0],
  '--allow-background-activity-starts': ['launch', 0],
  '--async': ['launch', 0],
  '--splashscreen-show-icon': ['launch', 0],
  '--dismiss-keyguard-if-insecure': ['launch', 0],
  '--dismiss-keyguard': ['launch', 0],
  '--allow-fgs-start-reason': ['launch', 1],
};

type ParsedAndroidIntentOption = {
  name: string;
  audience: AndroidIntentOption[0];
  end: number;
  value: string | undefined;
};

function readAndroidIntentOption(
  args: readonly string[],
  index: number,
  token: string,
): ParsedAndroidIntentOption | undefined {
  const attachedValue = token.length > 2 && token[1] !== '-';
  const name = attachedValue ? token.slice(0, 2) : token;
  const option = ANDROID_INTENT_OPTIONS[name];
  if (!option || (attachedValue && option[1] === 0)) return undefined;
  const end = index + 1 + option[1] - Number(attachedValue);
  if (end > args.length) return undefined;
  return {
    name,
    audience: option[0],
    end,
    value: attachedValue ? token.slice(2) : args[index + 1],
  };
}

function canResolvePositionalIntent(token: string | undefined, type: string | undefined): boolean {
  return !token?.startsWith('intent:') && !(token?.startsWith('content:') && type === undefined);
}

function needsContentType(data: string | undefined, type: string | undefined): boolean {
  // am start resolves content-provider MIME types; package lookup does not.
  return data?.startsWith('content:') === true && type === undefined;
}

type AndroidIntentMime = { data?: string; type?: string };

function updateAndroidIntentMime(
  mime: AndroidIntentMime,
  name: string,
  value: string | undefined,
): boolean {
  if (name === '-d') mime.data = value;
  if (name === '-t') mime.type = value;
  return name !== '--selector' || !needsContentType(mime.data, mime.type);
}

function readAndroidIntentArguments(args: readonly string[]):
  | {
      options: Array<ParsedAndroidIntentOption & { tokens: string[] }>;
      positional: string[];
    }
  | undefined {
  const options: Array<ParsedAndroidIntentOption & { tokens: string[] }> = [];
  let index = 0;
  while (true) {
    const token = args[index];
    if (token === undefined) return { options, positional: [] };
    if (!token.startsWith('-') || token === '--') return { options, positional: args.slice(index) };
    const option = readAndroidIntentOption(args, index, token);
    if (!option) return undefined;
    options.push({ ...option, tokens: args.slice(index, option.end) });
    index = option.end;
  }
}

function androidIntentResolutionArgs(args: readonly string[]): string[] | undefined {
  const parsed = readAndroidIntentArguments(args);
  if (!parsed) return undefined;
  const resolutionArgs: string[] = [];
  const mime: AndroidIntentMime = {};
  for (const option of parsed.options) {
    if (!updateAndroidIntentMime(mime, option.name, option.value)) return undefined;
    if (option.audience === 'intent') resolutionArgs.push(...option.tokens);
  }
  const positional = parsed.positional[parsed.positional[0] === '--' ? 1 : 0];
  if (!canResolvePositionalIntent(positional, mime.type) || needsContentType(mime.data, mime.type))
    return undefined;
  resolutionArgs.push(...parsed.positional);
  return resolutionArgs;
}

/** Launch stays verbatim; resolution receives only complete, recognized intent options. */
export function buildAndroidIntentArgs(
  intent: string,
  launchArgs: readonly string[] = [],
): { launchArgs: string[]; resolutionArgs: string[] | undefined } {
  const resolutionArgs = androidIntentResolutionArgs(launchArgs);
  return {
    launchArgs: ['-a', intent, ...launchArgs],
    resolutionArgs: resolutionArgs && ['-a', intent, ...resolutionArgs],
  };
}
