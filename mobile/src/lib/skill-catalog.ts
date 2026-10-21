import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { BuiltinSkill, Skill } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";

/** Read-only filesystem catalog; focus refreshes catch direct file edits, events catch gateway deletions. */
export function useSkillCatalog(session: ChatSession): {
  skills: Skill[]; defaultAgentId: string | null; loaded: boolean; refreshing: boolean; error: string; refresh: () => void;
} {
  const revision = useSyncExternalStore(session.subscribe, () => session.skillRevision);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ session: ChatSession; skills: Skill[]; defaultAgentId: string | null; loaded: boolean; refreshing: boolean; error: string }>(
    { session, skills: [], defaultAgentId: null, loaded: false, refreshing: false, error: "" },
  );
  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true }));
    setRetry((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void session.api.listSkills().then(
      ({ skills, default_agent_id }) => {
        if (active) setState({ session, skills, defaultAgentId: default_agent_id, loaded: true, refreshing: false, error: "" });
      },
      (reason: unknown) => {
        if (active) setState((current) => ({
          session, skills: current.session === session ? current.skills : [],
          defaultAgentId: current.session === session ? current.defaultAgentId : null,
          refreshing: false,
          loaded: current.session === session && current.loaded,
          error: `无法加载技能：${reason instanceof Error ? reason.message : String(reason)}`,
        }));
      },
    );
    return () => { active = false; };
  }, [session, revision, retry]);

  return state.session === session ? { ...state, refresh } : { skills: [], defaultAgentId: null, loaded: false, refreshing: false, error: "", refresh };
}

/** Builtin catalog is a separate route: a workspace error must not hide system skills. */
export function useBuiltinSkillCatalog(session: ChatSession): {
  skills: BuiltinSkill[]; loaded: boolean; refreshing: boolean; error: string; refresh: () => void;
} {
  const revision = useSyncExternalStore(session.subscribe, () => session.skillRevision);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ session: ChatSession; skills: BuiltinSkill[]; loaded: boolean; refreshing: boolean; error: string }>(
    { session, skills: [], loaded: false, refreshing: false, error: "" },
  );
  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true }));
    setRetry((value) => value + 1);
  }, []);
  useEffect(() => {
    let active = true;
    void session.api.listBuiltinSkills().then(
      ({ skills }) => {
        if (active) setState({ session, skills, loaded: true, refreshing: false, error: "" });
      },
      (reason: unknown) => {
        if (active) setState((current) => ({
          session, skills: current.session === session ? current.skills : [],
          loaded: current.session === session && current.loaded, refreshing: false,
          error: `无法加载系统内置技能：${reason instanceof Error ? reason.message : String(reason)}`,
        }));
      },
    );
    return () => { active = false; };
  }, [session, revision, retry]);
  return state.session === session ? { ...state, refresh } : { skills: [], loaded: false, refreshing: false, error: "", refresh };
}
