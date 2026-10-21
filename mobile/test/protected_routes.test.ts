import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StackActions, StackRouter } from "expo-router/build/react-navigation/routers/StackRouter.js";

import { authenticatedScreens, developmentScreens, sharedScreens } from "../src/lib/root-stack-routes.ts";

const appDirectory = fileURLToPath(new URL("../src/app/", import.meta.url));

function actualRoutes(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return actualRoutes(join(directory, entry.name), relative);
    if (!/\.[jt]sx?$/.test(entry.name) || entry.name.startsWith("_layout.")) return [];
    return [relative.replace(/\.[jt]sx?$/, "")];
  });
}

const signedIn = authenticatedScreens.map((screen) => screen.name);
const signedOut = sharedScreens.map((screen) => screen.name);
const paired = [...signedIn, ...signedOut]; // Authenticated index precedes shared connect when both are available.
const router = StackRouter({});
const options = (routeNames: string[]) => ({ routeNames, routeParamList: {}, routeGetIdList: {} });

test("every file route is declared once; pairing is available with and without a computer", () => {
  const declared = [...paired, ...developmentScreens.map((screen) => screen.name)];
  assert.equal(router.getInitialState(options(paired)).routes[0].name, "index");
  assert.equal(router.getInitialState(options(signedOut)).routes[0].name, "connect");
  assert.equal(new Set(declared).size, declared.length, "a route must not be declared in both groups");
  assert.deepEqual([...declared].sort(), actualRoutes(appDirectory).sort(), "unlisted file routes are implicitly unprotected by Expo Router");
});

test("production navigation cannot open development preview links", () => {
  for (const routeNames of [paired, signedOut]) {
    const production = options(routeNames);
    const state = router.getInitialState(production);
    for (const screen of developmentScreens) {
      assert.equal(router.getStateForAction(state, StackActions.push(screen.name), production), null);
    }
  }
});

test("invalid authentication can reach saved computers and re-pair without exposing conversation routes", () => {
  const available = options(signedOut);
  const entry = router.getInitialState(available);
  const computers = router.getStateForAction(entry, StackActions.push("gateway-connection"), available);
  assert.ok(computers?.stale === false);
  const repair = router.getStateForAction(computers, StackActions.push("connect", { repair: "old-installation" }), available);
  assert.ok(repair?.stale === false);
  assert.deepEqual(repair.routes[repair.index].params, { repair: "old-installation" });
  assert.equal(router.getStateForAction(computers, StackActions.push("c/[id]", { id: "private" }), available), null);
});

test("a paired user can cancel pairing back to the previous page or replace it with home", () => {
  const pairedOptions = options(paired);
  const initial = router.getInitialState(pairedOptions);
  const settings = router.getStateForAction(initial, StackActions.push("gateway-connection"), pairedOptions);
  assert.ok(settings?.stale === false);
  const connect = router.getStateForAction(settings, StackActions.push("connect"), pairedOptions);
  assert.ok(connect?.stale === false);
  assert.deepEqual(connect.routes.map((route) => route.name), ["index", "gateway-connection", "connect"]);
  const cancelled = router.getStateForAction(connect, StackActions.pop(), pairedOptions);
  assert.ok(cancelled?.stale === false);
  assert.equal(cancelled.routes[cancelled.index].name, "gateway-connection");
  const pairedAgain = router.getStateForAction(connect, StackActions.replace("index"), pairedOptions);
  assert.ok(pairedAgain?.stale === false);
  assert.equal(pairedAgain.routes[pairedAgain.index].name, "index");
  assert.equal(pairedAgain.routes.some((route) => route.name === "connect"), false);
});

test("switching resets deep authenticated history; removing the last computer returns to connect", () => {
  const pairedOptions = options(paired);
  const signedOutOptions = options(signedOut);
  let oldSession = router.getInitialState(pairedOptions);
  for (const name of ["c/[id]", "browser-viewer", "files/[id]"]) {
    const next = router.getStateForAction(oldSession, StackActions.push(name, { id: "old-computer-id" }), pairedOptions);
    assert.ok(next?.stale === false);
    oldSession = next;
  }
  // The cutover guard first removes all old resource routes, including URL-derived ones.
  const gated = router.getStateForRouteNamesChange(oldSession, { ...signedOutOptions, routeKeyChanges: [] });
  assert.deepEqual(gated.routes.map((route) => route.name), ["connect"]);
  const admitted = router.getStateForRouteNamesChange(gated, { ...pairedOptions, routeKeyChanges: [] });
  // Merely re-enabling authenticated routes leaves connect current. Pairing and passive
  // revocation fallback must explicitly open home after the new navigator is admitted.
  assert.equal(admitted.routes[admitted.index].name, "connect");
  const newSession = router.getStateForAction(admitted, StackActions.replace("index"), pairedOptions);
  assert.ok(newSession?.stale === false);
  assert.deepEqual(newSession.routes.map((route) => route.name), ["index"]);
  assert.equal(JSON.stringify(newSession).includes("old-computer-id"), false);
  const newConversation = router.getStateForAction(newSession, StackActions.push("c/[id]", { id: "new-computer-id" }), pairedOptions);
  assert.ok(newConversation?.stale === false);
  assert.deepEqual(newConversation.routes[newConversation.index].params, { id: "new-computer-id" });

  const afterLastRemoval = router.getStateForRouteNamesChange(oldSession, { ...signedOutOptions, routeKeyChanges: [] });
  assert.deepEqual(afterLastRemoval.routes.map((route) => route.name), ["connect"]);
  assert.equal(router.getStateForAction(afterLastRemoval, StackActions.push("files/[id]", { id: "old-computer-id" }), signedOutOptions), null);
});
