/**
 * The fake appliances: a refrigerator and a dishwasher, with ThinQ-style
 * device info, profile and state, and a little behaviour behind control
 * commands so integration tests can exercise realistic flows.
 *
 * `simulate()` plays someone using the appliance (opening a door, pressing a
 * button on its panel), so the state changes on its own the way a real one
 * would - which the app picks up as device events. Simulated actions only
 * produce states the device profile allows.
 */
import {
  FakeThinQError,
  applyChanges,
  mergeState,
  validateCommand,
  type Change,
  type DeviceProfile,
  type PropSpec,
  type Json,
} from "./protocol.js";

export interface DeviceInfo {
  deviceType: string;
  modelName: string;
  alias: string;
  reportable: boolean;
}

export abstract class FakeDevice {
  /** When false, state and control calls fail with NOT_CONNECTED_DEVICE. */
  online = true;
  protected state: Json = {};

  constructor(
    readonly deviceId: string,
    readonly deviceInfo: DeviceInfo,
    readonly profile: DeviceProfile,
  ) {}

  /** Restore the initial state. */
  reset(): void {
    this.online = true;
    this.state = structuredClone(this.initialState());
  }

  /** The device as listed by `GET /devices`. */
  listing(): Json {
    return { deviceId: this.deviceId, deviceInfo: { ...this.deviceInfo } };
  }

  /** Current state at time `now` (ms since epoch). */
  snapshot(now: number): Json {
    this.advance(now);
    return structuredClone(this.state);
  }

  /** Validate a control command against the profile, then apply it. */
  control(command: unknown, now: number): void {
    this.advance(now);
    const changes = validateCommand(this.profile, this.state, command);
    this.apply(changes, now);
  }

  /** Scenario hook: deep-merge a partial state, bypassing validation. */
  patchState(patch: Json): void {
    mergeState(this.state, patch);
  }

  /**
   * Simulate someone using the appliance: one plausible action at time `now`,
   * described in words, or null when nothing happens. `random` returns values
   * in [0, 1). A disconnected appliance does nothing.
   */
  simulate(random: () => number, now: number): string | null {
    if (!this.online) return null;
    this.advance(now);
    return this.act(random, now);
  }

  protected abstract initialState(): Json;

  /** The device-specific part of `simulate`. */
  protected act(_random: () => number, _now: number): string | null {
    return null;
  }

  /** Let time-based behaviour catch up (e.g. a running cycle finishing). */
  protected advance(_now: number): void {}

  protected apply(changes: Change[], _now: number): void {
    applyChanges(this.state, changes);
  }
}

// ---------------------------------------------------------------------------
// Refrigerator

/** A read/write on-off switch; a function so each profile gets its own copy. */
const onOff = (): PropSpec => ({ type: "boolean", mode: ["r", "w"], value: { r: [true, false], w: [true, false] } });

export const FRIDGE_ID = "b2f6c91d0a4e4f5c9e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d";

export class FakeRefrigerator extends FakeDevice {
  constructor(deviceId = FRIDGE_ID) {
    super(
      deviceId,
      { deviceType: "DEVICE_REFRIGERATOR", modelName: "GBB92STAXP", alias: "Kitchen Fridge", reportable: true },
      {
        property: {
          doorStatus: [
            { locationName: "MAIN", doorState: { type: "enum", mode: ["r"], value: { r: ["OPEN", "CLOSE"] } } },
          ],
          temperature: [
            {
              locationName: "FRIDGE",
              targetTemperature: { type: "range", mode: ["r", "w"], value: { r: { min: 1, max: 7, step: 1 }, w: { min: 1, max: 7, step: 1 } } },
              unit: { type: "enum", mode: ["r"], value: { r: ["C", "F"] } },
            },
            {
              locationName: "FREEZER",
              targetTemperature: { type: "range", mode: ["r", "w"], value: { r: { min: -23, max: -15, step: 1 }, w: { min: -23, max: -15, step: 1 } } },
              unit: { type: "enum", mode: ["r"], value: { r: ["C", "F"] } },
            },
          ],
          powerSave: { powerSaveEnabled: onOff() },
          ecoFriendly: { ecoFriendlyMode: onOff() },
          sabbath: { sabbathMode: { type: "boolean", mode: ["r"], value: { r: [true, false] } } },
          refrigeration: {
            expressMode: onOff(),
            expressFridge: onOff(),
            freshAirFilter: {
              type: "enum",
              mode: ["r", "w"],
              value: { r: ["OFF", "AUTO", "POWER", "REPLACE"], w: ["OFF", "AUTO", "POWER"] },
            },
          },
          waterFilterInfo: {
            usedTime: { type: "number", mode: ["r"] },
            unit: { type: "enum", mode: ["r"], value: { r: ["MONTH", "TIMES"] } },
          },
        },
        notification: { push: ["DOOR_IS_OPEN", "WATER_FILTER_NEEDS_REPLACEMENT"] },
      },
    );
    this.reset();
  }

  protected initialState(): Json {
    return {
      doorStatus: [{ locationName: "MAIN", doorState: "CLOSE" }],
      temperature: [
        { locationName: "FRIDGE", targetTemperature: 3, unit: "C" },
        { locationName: "FREEZER", targetTemperature: -18, unit: "C" },
      ],
      powerSave: { powerSaveEnabled: false },
      ecoFriendly: { ecoFriendlyMode: false },
      sabbath: { sabbathMode: false },
      refrigeration: { expressMode: false, expressFridge: false, freshAirFilter: "AUTO" },
      waterFilterInfo: { usedTime: 4, unit: "MONTH" },
    };
  }

  /** Simulation steps express fridge has been on for; it switches itself off. */
  private expressSteps = 0;

  override reset(): void {
    this.expressSteps = 0;
    super.reset();
  }

  /**
   * Someone at the fridge: the door opens and closes again on the next step;
   * express fridge is switched on at the panel and turns itself off after a
   * few steps; the fridge compartment is nudged by a degree. In sabbath mode
   * only the door moves (the panel is locked).
   */
  protected override act(random: () => number): string | null {
    const door = (this.state.doorStatus as Json[]).find((d) => d.locationName === "MAIN")!;
    if (door.doorState === "OPEN") {
      door.doorState = "CLOSE";
      return "door closed";
    }
    const refrigeration = this.state.refrigeration as Json;
    if (refrigeration.expressFridge === true && ++this.expressSteps >= 3) {
      refrigeration.expressFridge = false;
      this.expressSteps = 0;
      return "express fridge finished";
    }
    const sabbath = (this.state.sabbath as Json).sabbathMode === true;
    const roll = random();
    if (roll < 0.5 || sabbath) {
      door.doorState = "OPEN";
      return "door opened";
    }
    if (roll < 0.7 && refrigeration.expressFridge !== true) {
      refrigeration.expressFridge = true;
      this.expressSteps = 0;
      return "express fridge switched on at the panel";
    }
    if (roll < 0.9) {
      const fridge = (this.state.temperature as Json[]).find((t) => t.locationName === "FRIDGE")!;
      const current = fridge.targetTemperature as number;
      let next = current + (random() < 0.5 ? -1 : 1);
      if (next < 1 || next > 7) next = current - (next - current); // bounce off the 1..7 range
      fridge.targetTemperature = next;
      return `fridge set to ${next} °C at the panel`;
    }
    return null;
  }

  protected override apply(changes: Change[], now: number): void {
    // Sabbath mode locks the controls on real appliances.
    if ((this.state.sabbath as Json | undefined)?.sabbathMode === true) {
      throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_STATE", "Controls are locked while sabbath mode is on");
    }
    super.apply(changes, now);
  }
}

// ---------------------------------------------------------------------------
// Dishwasher

export const DISHWASHER_ID = "7d3e9a1c5b2f4e8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b";

/** Programme length per course, in minutes. */
export const COURSE_MINUTES: Record<string, number> = {
  AUTO: 135,
  NORMAL: 120,
  HEAVY: 160,
  DELICATE: 100,
  TURBO: 60,
  ECO: 200,
  QUICK: 30,
};

const MINUTE = 60_000;

/**
 * Dishwasher state machine (driven by `operation.dishWasherOperationMode`):
 *
 *   POWER_OFF  --(power on at the appliance)-->  INITIAL
 *   INITIAL/END --START--> RUNNING --(programme time elapses)--> END
 *   RUNNING --STOP--> INITIAL;  any --POWER_OFF--> POWER_OFF
 *
 * START needs remote start enabled on the appliance (`remoteControlEnabled`,
 * off by default like the real thing), a closed door and power on.
 */
export class FakeDishWasher extends FakeDevice {
  private cycle: { startedAt: number; minutes: number } | null = null;

  constructor(deviceId = DISHWASHER_ID) {
    super(
      deviceId,
      { deviceType: "DEVICE_DISH_WASHER", modelName: "DFB532FP", alias: "Dishwasher", reportable: true },
      {
        property: {
          runState: {
            currentState: { type: "enum", mode: ["r"], value: { r: ["POWER_OFF", "INITIAL", "RUNNING", "END", "ERROR"] } },
          },
          dishWashingStatus: { rinseRefill: { type: "boolean", mode: ["r"], value: { r: [true, false] } } },
          preference: {
            rinseLevel: { type: "enum", mode: ["r"], value: { r: ["LEVEL_0", "LEVEL_1", "LEVEL_2", "LEVEL_3", "LEVEL_4"] } },
            softeningLevel: { type: "enum", mode: ["r"], value: { r: ["LEVEL_0", "LEVEL_1", "LEVEL_2", "LEVEL_3", "LEVEL_4"] } },
          },
          doorStatus: { doorState: { type: "enum", mode: ["r"], value: { r: ["OPEN", "CLOSE"] } } },
          operation: {
            dishWasherOperationMode: { type: "enum", mode: ["w"], value: { w: ["START", "STOP", "POWER_OFF"] } },
          },
          remoteControlEnable: { remoteControlEnabled: { type: "boolean", mode: ["r"], value: { r: [true, false] } } },
          timer: {
            remainHour: { type: "number", mode: ["r"] },
            remainMinute: { type: "number", mode: ["r"] },
            totalHour: { type: "number", mode: ["r"] },
            totalMinute: { type: "number", mode: ["r"] },
          },
          dishWashingCourse: {
            currentDishWashingCourse: { type: "enum", mode: ["r"], value: { r: Object.keys(COURSE_MINUTES) } },
          },
        },
        notification: { push: ["CLEANING_IS_COMPLETE", "RINSE_IS_NOT_ENOUGH", "WATER_LEAK_HAS_OCCURRED"] },
      },
    );
    this.reset();
  }

  override reset(): void {
    this.cycle = null;
    super.reset();
  }

  protected initialState(): Json {
    return {
      runState: { currentState: "INITIAL" },
      dishWashingStatus: { rinseRefill: false },
      preference: { rinseLevel: "LEVEL_2", softeningLevel: "LEVEL_3" },
      doorStatus: { doorState: "CLOSE" },
      remoteControlEnable: { remoteControlEnabled: false },
      timer: { remainHour: 0, remainMinute: 0, totalHour: 0, totalMinute: 0 },
      dishWashingCourse: { currentDishWashingCourse: "AUTO" },
    };
  }

  private get currentState(): string {
    return (this.state.runState as Json).currentState as string;
  }

  private setTimer(remaining: number, total: number): void {
    this.state.timer = {
      remainHour: Math.floor(remaining / 60),
      remainMinute: remaining % 60,
      totalHour: Math.floor(total / 60),
      totalMinute: total % 60,
    };
  }

  protected override advance(now: number): void {
    if (this.currentState !== "RUNNING" || !this.cycle) return;
    const elapsed = Math.floor((now - this.cycle.startedAt) / MINUTE);
    const remaining = Math.max(0, this.cycle.minutes - elapsed);
    this.setTimer(remaining, this.cycle.minutes);
    if (remaining === 0) {
      (this.state.runState as Json).currentState = "END";
      this.cycle = null;
    }
  }

  protected override apply(changes: Change[], now: number): void {
    for (const change of changes) {
      if (change.resource !== "operation") continue;
      switch (change.value) {
        case "START":
          this.start(now);
          break;
        case "STOP":
          if (this.currentState !== "RUNNING") {
            throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_STATE", `Cannot STOP while ${this.currentState}`);
          }
          this.cycle = null;
          (this.state.runState as Json).currentState = "INITIAL";
          this.setTimer(0, 0);
          break;
        case "POWER_OFF":
          this.cycle = null;
          (this.state.runState as Json).currentState = "POWER_OFF";
          (this.state.remoteControlEnable as Json).remoteControlEnabled = false;
          this.setTimer(0, 0);
          break;
      }
    }
  }

  /**
   * Someone at the dishwasher: powers it on if it is off; opens the door
   * (which cancels remote start, as on LG dishwashers) and closes it on the
   * next step; enables remote start so the app can start it; or starts a
   * short programme at the panel, which then runs to the end. A running
   * programme is left alone.
   */
  protected override act(random: () => number, now: number): string | null {
    const state = this.currentState;
    if (state === "RUNNING") return null;
    if (state === "POWER_OFF") {
      (this.state.runState as Json).currentState = "INITIAL";
      return "powered on at the panel";
    }
    const door = this.state.doorStatus as Json;
    const remote = this.state.remoteControlEnable as Json;
    if (door.doorState === "OPEN") {
      door.doorState = "CLOSE";
      return "door closed";
    }
    const roll = random();
    if (roll < 0.4) {
      door.doorState = "OPEN";
      remote.remoteControlEnabled = false;
      return "door opened";
    }
    if (roll < 0.7) {
      const course = random() < 0.5 ? "QUICK" : "TURBO";
      (this.state.dishWashingCourse as Json).currentDishWashingCourse = course;
      this.beginCycle(course, now);
      return `${course} programme started at the panel`;
    }
    if (roll < 0.9 && remote.remoteControlEnabled !== true) {
      remote.remoteControlEnabled = true;
      return "remote start enabled at the panel";
    }
    return null;
  }

  private start(now: number): void {
    const state = this.currentState;
    if (state === "POWER_OFF") {
      throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_POWER_OFF", "The dishwasher is off; it must be powered on at the appliance");
    }
    if ((this.state.remoteControlEnable as Json).remoteControlEnabled !== true) {
      throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_REMOTE_OFF", "Remote start is not enabled on the appliance");
    }
    if ((this.state.doorStatus as Json).doorState !== "CLOSE") {
      throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_STATE", "Cannot START while the door is open");
    }
    if (state !== "INITIAL" && state !== "END") {
      throw new FakeThinQError("COMMAND_NOT_SUPPORTED_IN_STATE", `Cannot START while ${state}`);
    }
    this.beginCycle((this.state.dishWashingCourse as Json).currentDishWashingCourse as string, now);
  }

  private beginCycle(course: string, now: number): void {
    const minutes = COURSE_MINUTES[course] ?? COURSE_MINUTES.AUTO;
    this.cycle = { startedAt: now, minutes };
    (this.state.runState as Json).currentState = "RUNNING";
    this.setTimer(minutes, minutes);
  }
}
