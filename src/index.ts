/**
 * eufy-sdk — one typed client for every Anker eufy device.
 *
 * Log in, model devices as capability-driven objects with a fluent typed API,
 * and subscribe to typed semantic events. Transport is internal.
 */

// Facade: the EufyMega client + its public options/event types.
export * from "./client/index.js";

// Shared primitives: crypto, cross-cutting types, session store, utils.
export * from "./core/index.js";

// Device connectivity — internal wire, surfaced for advanced/escape-hatch use.
export * from "./transport/index.js";

// Device model: capability-driven Device + capability modules (incl. the Anker Solix device model).
export * from "./model/index.js";
