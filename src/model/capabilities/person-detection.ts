import { DoorbellPushEvent, HB3PairedDevicePushEvent } from "../push-events.js";
import type { CapabilityModule, EventClaim } from "./types.js";

/**
 * Evidence a device deals in the IDENTIFIED person ids: it hangs off a station.
 *
 * 3111 and 3112 are declared in {@link HB3PairedDevicePushEvent} and in no other family's vocabulary,
 * so a unit that stands alone is not in the population that issues them. 3102 carries no such claim:
 * it is declared in the doorbell, indoor and HB3-paired vocabularies alike, so every camera family
 * can announce a face, and a standalone camera keeps `personDetected` through it.
 *
 * Attachment to ANY station is the gate rather than to a HomeBase 3 specifically: the coarser test
 * keeps the events on an attached camera whose station generation is not established, which is the
 * direction that cannot lose a real detection.
 */
const IDENTIFIED_PERSON_CLAIM: EventClaim = { homeBaseAttached: true };

/**
 * `person_detection` — human/AI detection.
 *
 * Push events are the whole read surface: a person arrives as an event, and no owned camera reports a
 * detection-enable or detected-state parameter, so there is nothing for a state table to project.
 */
export const PERSON_DETECTION: CapabilityModule = {
  capability: "person_detection",
  description: "AI human detection enable switch and live detected state.",
  properties: [],
  /** Camera push traffic emits these semantic events even when no person-detection state param is reported. */
  detection: { codecs: ["camera"] },
  /**
   * Inbound AI person events. A face or an identified person is `personDetected`; an explicitly
   * UNRECOGNISED person is `strangerDetected`.
   *
   * The two are split because they mean opposite things — "someone known is at the door" versus
   * "someone unrecognised" — and collapsing them loses the distinction the device went to the trouble
   * of making.
   */
  events: [
    { source: "push", match: DoorbellPushEvent.FACE_DETECTION, emit: "personDetected" },
    {
      source: "push",
      match: HB3PairedDevicePushEvent.IDENTITY_PERSON_DETECTION,
      emit: "personDetected",
      claim: IDENTIFIED_PERSON_CLAIM,
    },
    {
      source: "push",
      match: HB3PairedDevicePushEvent.STRANGER_PERSON_DETECTION,
      emit: "strangerDetected",
      claim: IDENTIFIED_PERSON_CLAIM,
    },
  ],
};
