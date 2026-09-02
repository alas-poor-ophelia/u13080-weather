/**
 * The closed component bin (SPEC §0 law 3). The studio's UI is composed only
 * from these nine parts. Adding a tenth is an argued decision, not a
 * convenience — new entity kinds get a declaration that projects onto these.
 *
 * Every factory has the same shape: `create<Part>(parent, props)` appends its
 * root to `parent` and returns `{ el, update(partial), destroy() }`.
 */
export { createKnob, type KnobComponent, type KnobPhase, type KnobProps } from "./knob";
export { createLed, type LedComponent, type LedLevel, type LedProps, type LedScope } from "./led";
export { createChip, type ChipComponent, type ChipProps } from "./chip";
export { createLane, type LaneComponent, type LaneProps } from "./lane";
export { createChart, type ChartComponent, type ChartDomain, type ChartKind, type ChartMarker, type ChartPhase, type ChartProps, type ChartSeries } from "./chart";
export { createRackUnit, type GripPhase, type RackUnitComponent, type RackUnitProps } from "./rack-unit";
export { createWindow, type IssueLevel, type WindowComponent, type WindowIssue, type WindowPreset, type WindowProps } from "./window";
export { createWrites, type WritesComponent, type WritesProps } from "./writes";
export { createSegmented, type SegmentedComponent, type SegmentedOption, type SegmentedProps } from "./segmented";

/** What every part in the bin returns. Structural — no base class, no framework. */
export interface Component<P> {
  el: HTMLElement;
  update(next: Partial<P>): void;
  destroy(): void;
}
