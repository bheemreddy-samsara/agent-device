import { CLICK_BUTTONS } from '@agent-device/contracts/click-button';
import {
  type DragGesturePayload,
  type FlingGesturePayload,
  GESTURE_KINDS,
  type PanGesturePayload,
  type PinchGesturePayload,
  type RotateGesturePayload,
  type SwipeGesturePayload,
  type TransformGesturePayload,
  readGesturePayload,
} from '@agent-device/contracts/gesture-input';
import { SCROLL_DURATION_MAX_MS } from '@agent-device/contracts/scroll-command';
import { IS_PREDICATES } from '@agent-device/contracts/is-predicate';
import {
  SCROLL_DIRECTIONS,
  SCROLL_INPUT_DIRECTIONS,
  SWIPE_PATTERNS,
  SWIPE_PAUSE_MAX_MS,
  SWIPE_PRESETS,
  SWIPE_REPETITION_MAX,
} from '@agent-device/contracts/scroll-gesture';
import { FIND_LOCATORS } from '@agent-device/selectors';
import {
  booleanField,
  elementTargetField,
  enumField,
  integerField,
  interactionTargetField,
  numberField,
  operatorField,
  pointField,
  repeatedFields,
  requiredField,
  selectorSnapshotFields,
  stringField,
  type CommandFieldMap,
  type InferCommandInput,
} from '../command-input.ts';
import { readCommonInput, type CommonCommandInput } from '../common-input-fields.ts';
import { readInputRecord } from '../input-readers.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { postActionObservationFields } from '../post-action-observation-grammar.ts';

const FIND_ACTION_VALUES = [
  'click',
  'focus',
  'exists',
  'list',
  'getText',
  'getAttrs',
  'wait',
  'fill',
  'type',
] as const;

const interactionCommandDescriptions = {
  click:
    'Activate a UI target by snapshot ref, selector, or coordinates. After a snapshot, prefer a ref or selector. Use coordinates only when semantic targeting is unavailable. This command can change the app state. Success means that the command dispatched the click, not that the click reached the intended target. To confirm the result without a follow-up snapshot, use settle or verify, or wait for the expected screen. If the previous action of the session animated the screen, the command examines a ref or selector target for motion before dispatch. It then dispatches at the resting position of the target. If the target has not stopped, the command refuses with target_still_moving and does not act at the earlier position.',
  press:
    'Short-press a UI target by snapshot ref, selector, or coordinates. If the target requires a context-menu or hold gesture, use longpress instead. Success means that the command dispatched the press, not that the press reached the intended target. To confirm the result, use settle or verify, or wait for the expected screen. If the previous action of the session animated the screen, the command examines a ref or selector target for motion before dispatch. It then dispatches at the resting position of the target. If the target has not stopped, the command refuses with target_still_moving and does not act at the earlier position.',
  fill: 'Replace the text in a UI input that a snapshot ref, selector, or coordinates select. To clear the field, pass an empty text. Before you continue, examine unconfirmed evidence, and assert the expected value or the resulting screen. After a snapshot, prefer refs or selectors. To send sensitive text to the live app but keep it out of a recorded replay, use recordAs.',
  longpress:
    'Hold a UI target by snapshot ref, selector, or coordinates to open a context menu or to do a different hold gesture. If the default hold duration is unsuitable, set durationMs.',
  hover:
    'Move the pointer over a UI target by snapshot ref, selector, or coordinates, without a press. Use it to show hover-gated UI, such as row toolbars or menus. Web only. Touch platforms have no hover state. To observe what the hover showed without a follow-up snapshot, use settle.',
  swipe: 'Do a quick fling between coordinates, with an optional repeat pattern.',
  focus:
    'Move the input focus to explicit screen coordinates without text entry. If a snapshot ref or selector is available, prefer semantic interactions. After focus, use type or fill.',
  type: 'Append text to the input that has focus. To replace the existing field value, use fill. If no input is active, use focus first.',
  scroll:
    'Scroll in a direction, or toward the top or bottom edge of scrollable content. To reach an off-screen target in one command instead of a scroll-and-check loop, set until to a selector. The optional amount is the finger-path fraction of the viewport axis. The command honors an amount up to 0.8 of the axis. Directional scrolls reduce release momentum, but app scroll physics set the final content offset. A visible keyboard makes the swiped band shorter, and the command does not dismiss the keyboard. If too little of the band is left, the command refuses with scroll_keyboard_occludes_surface. A directional scroll also reports the movement that it observed as movement: moved, at-edge, unchanged, or unobserved. unobserved means that the two reads could not support a claim either way. If the surface is unchanged inside a container that still hides content in that direction, the command refuses with scroll_no_progress. It does not repeat the requested distance. The movement field is absent when a tier confirms each pass (top/bottom, until), when the runtime cannot read a screen, or when a settle observation or a replay already owns that observation.',
  get: 'Read the text or the accessibility attributes of a snapshot ref or selector. The command does not change the app. For visible content, use format text. For the element attribute map, use format attrs.',
  is: 'Examine whether a selector satisfies a UI predicate, such as visible, hidden, exists, absent, editable, selected, focused, or text. `absent` passes only when one readable, complete, settled, unscoped, full-depth accessibility capture has zero matches. If the condition may appear asynchronously, use wait.',
  find: 'Find an element by text, label, value, role, or id, and run an action. The role locator matches the snapshot kind vocabulary (button, text, text-field, switch, ...). During a deprecation window, the command still accepts pre-reconciliation leaf spellings (statictext, edittext, textview) on the nodes that carried them.',
  gesture:
    'Do a structured pan, fling, swipe, pinch, rotate, transform, or drag gesture. Select the gesture kind. Then give only the inputs that apply to that kind.',
} as const;

type InteractionCommandName = keyof typeof interactionCommandDescriptions;

const clickFields = {
  target: requiredField(interactionTargetField()),
  button: enumField(CLICK_BUTTONS, 'Pointer button for platforms that support mouse buttons.'),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('click'),
};

const pressFields = {
  target: requiredField(interactionTargetField()),
  ...selectorSnapshotFields(),
  ...repeatedFields(),
  ...postActionObservationFields('press'),
};

const fillFields = {
  target: requiredField(interactionTargetField()),
  // "" is accepted and means "replace with nothing", i.e. clear the field (#2063). The key
  // must still be present: omitting it is a missing argument, not a clear.
  text: requiredField(
    stringField('Text to enter into the target. To clear the target, pass "".', {
      allowEmpty: true,
    }),
  ),
  delayMs: integerField('Delay between typed characters.', { min: 0 }),
  recordAs: stringField(
    'When script recording is armed, send the text to the live app, but publish it as ${VAR}. Use an uppercase replay variable name, for example PASSWORD.',
  ),
  textStdin: operatorField(
    booleanField(
      'Operator-only: the CLI read the text from its stdin, so the text is kept out of diagnostics and recorded actions.',
    ),
    {
      operatorPath:
        'Pass --text-stdin on the CLI and pipe the text in; it is not exposed to model-facing tools.',
    },
  ),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('fill'),
};

const longPressFields = {
  target: requiredField(interactionTargetField()),
  durationMs: integerField('Long press duration in milliseconds.', { min: 0 }),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('longpress'),
};

const hoverFields = {
  target: requiredField(interactionTargetField()),
  ...selectorSnapshotFields(),
  ...postActionObservationFields('hover'),
};

const swipeFields = {
  from: requiredField(pointField('Swipe start point.')),
  to: requiredField(pointField('Swipe end point.')),
  count: integerField('Number of swipe repetitions.', { min: 1, max: SWIPE_REPETITION_MAX }),
  pauseMs: integerField('Pause between repeated swipes.', { min: 0, max: SWIPE_PAUSE_MAX_MS }),
  pattern: enumField(SWIPE_PATTERNS),
};

const focusFields = {
  x: requiredField(numberField('X coordinate.')),
  y: requiredField(numberField('Y coordinate.')),
};

const typeFields = {
  text: requiredField(stringField('Text to type.')),
  delayMs: integerField('Delay between typed characters.', { min: 0 }),
};

const scrollFields = {
  direction: requiredField(enumField(SCROLL_INPUT_DIRECTIONS)),
  amount: numberField('Platform scroll amount.'),
  pixels: integerField('Pixel scroll amount.', { min: 0 }),
  until: stringField(
    'Repeat scroll passes until this selector is visible on the screen, then stop. Not valid with the top and bottom edge directions, because they have their own stop condition.',
  ),
  durationMs: integerField('Scroll duration in milliseconds when the backend supports pacing.', {
    min: 0,
    max: SCROLL_DURATION_MAX_MS,
  }),
  ...postActionObservationFields('scroll'),
};

// #1271 stage 2 (ADR 0012 amendment): `get`/`is`/`find` are observation-only,
// so a repair-armed heal excludes an OUT-OF-BAND one by default. Both flags
// are exposed here so the Node SDK's typed options and the MCP tool schema can
// set them, mirroring `--no-record`/`--record` on the CLI. On `find`, `record`
// is valid only for a read-only action — a mutating `find … click|fill|focus|
// type` is refused as INVALID_ARGS by the daemon (`handleFindCommands`), since
// the observe-vs-mutate split is a positional the schema cannot see.
const recordControlFields = () => ({
  noRecord: booleanField('Do not record this action.'),
  record: booleanField(
    'Always record this out-of-band observation into a repair-armed heal (mutually exclusive with noRecord). Authored replay steps are recorded automatically and never need this field. On find, it is valid only for a read-only action.',
  ),
});

const getFields = {
  format: requiredField(enumField(['text', 'attrs'] as const)),
  target: requiredField(elementTargetField()),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
};

const isFields = {
  predicate: requiredField(enumField(IS_PREDICATES)),
  selector: requiredField(stringField()),
  value: stringField(),
  ...selectorSnapshotFields(),
  ...recordControlFields(),
};

const findFields = {
  locator: enumField(FIND_LOCATORS),
  query: requiredField(stringField()),
  action: enumField(FIND_ACTION_VALUES),
  // `find <q> fill ""` is the clear request (#2063); the daemon handler still refuses a MISSING
  // value, and an empty `type` value.
  value: stringField(undefined, { allowEmpty: true }),
  timeoutMs: integerField(),
  first: booleanField(),
  last: booleanField(),
  depth: integerField(),
  raw: booleanField(),
  ...recordControlFields(),
};

const gestureFields = {
  kind: requiredField(enumField(GESTURE_KINDS, 'Gesture variant.')),
  direction: enumField(SCROLL_DIRECTIONS, 'Fling direction.'),
  preset: enumField(SWIPE_PRESETS, 'Swipe preset.'),
  origin: pointField('Gesture origin point.'),
  delta: pointField('Movement delta for pan or transform gestures.'),
  distance: integerField('Fling distance.', { min: 0 }),
  scale: numberField('Pinch or transform scale.'),
  degrees: numberField('Rotation in degrees.'),
  durationMs: integerField('Pan or transform duration.', { min: 16, max: 10_000 }),
  pointerCount: integerField('Number of touch pointers for pan (1 or 2).', { min: 1, max: 2 }),
  source: stringField('Drag source @ref or selector.'),
  destination: stringField('Drag destination @ref or selector.'),
  sourceHoldMs: integerField('Hold duration for drag activation.', { min: 1, max: 10_000 }),
  moveMs: integerField('Drag movement duration.', { min: 16, max: 10_000 }),
  destinationHoldMs: integerField('Hold duration before the release at the destination.', {
    min: 0,
    max: 10_000,
  }),
};

export type ClickInput = InferCommandInput<typeof clickFields>;
export type PressInput = InferCommandInput<typeof pressFields>;
export type FillInput = InferCommandInput<typeof fillFields>;
export type LongPressInput = InferCommandInput<typeof longPressFields>;
export type HoverInput = InferCommandInput<typeof hoverFields>;
export type GetInput = InferCommandInput<typeof getFields>;

export type PanInput = CommonCommandInput & PanGesturePayload;
export type FlingInput = CommonCommandInput & FlingGesturePayload;
export type SwipeGestureInput = CommonCommandInput & SwipeGesturePayload;
export type PinchInput = CommonCommandInput & PinchGesturePayload;
export type RotateInput = CommonCommandInput & RotateGesturePayload;
export type TransformInput = CommonCommandInput & TransformGesturePayload;
export type DragInput = CommonCommandInput & DragGesturePayload;

export type GestureInput =
  | PanInput
  | FlingInput
  | SwipeGestureInput
  | PinchInput
  | RotateInput
  | TransformInput
  | DragInput;

export const interactionCommandMetadata = [
  defineInteractionCommandMetadata('click', clickFields),
  defineInteractionCommandMetadata('press', pressFields),
  defineInteractionCommandMetadata('fill', fillFields),
  defineInteractionCommandMetadata('longpress', longPressFields),
  defineInteractionCommandMetadata('hover', hoverFields),
  defineInteractionCommandMetadata('swipe', swipeFields),
  defineInteractionCommandMetadata('focus', focusFields),
  defineInteractionCommandMetadata('type', typeFields),
  defineInteractionCommandMetadata('scroll', scrollFields),
  defineInteractionCommandMetadata('get', getFields, { parseableOutput: true }),
  defineInteractionCommandMetadata('is', isFields),
  defineInteractionCommandMetadata('find', findFields, { parseableOutput: true }),
  defineFieldCommandMetadata('gesture', interactionCommandDescriptions.gesture, gestureFields, {
    readInput: readGestureInput,
  }),
] as const;

export function readGestureInput(input: unknown): GestureInput {
  const record = readInputRecord(input);
  return { ...readCommonInput(record), ...readGesturePayload(record) } as GestureInput;
}

function defineInteractionCommandMetadata<
  const TName extends InteractionCommandName,
  const TFields extends CommandFieldMap,
>(name: TName, fields: TFields, options?: { parseableOutput?: true }) {
  return defineFieldCommandMetadata(name, interactionCommandDescriptions[name], fields, options);
}
