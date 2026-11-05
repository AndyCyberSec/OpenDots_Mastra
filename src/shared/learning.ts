import { z } from 'zod';

export const learningContainerIdSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use 1–64 lowercase letters, numbers, and single hyphens.',
  )
  .nullable();

export function validateLearningSettings(
  containerId: string | null,
  delivery: boolean,
) {
  if (!learningContainerIdSchema.safeParse(containerId).success)
    throw new Error(
      'Dot Learning container ID must use 1–64 lowercase letters, numbers, and single hyphens.',
    );
  if (delivery && !containerId)
    throw new Error('Dot skill delivery requires a Learning container.');
}

/** Local Automatic Learning types shared by the server API and the React app. */
export type LearningSkillStatus = 'draft' | 'published' | 'rejected';

export interface LearningContainer {
  id: string;
  name: string;
  paused: boolean;
  threshold: number;
  createdAt: number;
  lastAnalyzedAt: number | null;
  lastAutoAttemptAt: number | null;
  lastAutoError: string | null;
  analyzedEvidenceAt: number | null;
  analyzedEvidenceCount: number;
}

export interface LearningContainerSummary extends LearningContainer {
  evidenceCount: number;
  threadCount: number;
  draftCount: number;
  publishedCount: number;
  ready: boolean;
  /** Persisted error from the last automatic analysis attempt, if any. */
  lastAutoError: string | null;
  /** When automatic analysis may run next (null when auto is disabled). */
  nextEligibleAt: number | null;
  /** Whether the automatic scheduler would analyze this container now. */
  autoEligible: boolean;
  /** Why automatic analysis is waiting, for the review panel. */
  autoReason:
    | 'disabled'
    | 'workspace_paused'
    | 'paused'
    | 'not_ready'
    | 'no_new_evidence'
    | 'interval'
    | 'eligible';
}

export interface LearningAutoTickResult {
  analyzedContainerId: string | null;
  proposed: number;
  error?: string;
}

export interface LearningSkill {
  id: string;
  containerId: string;
  name: string;
  description: string;
  content: string;
  status: LearningSkillStatus;
  source: string;
  evidenceCount: number;
  createdAt: number;
  reviewedAt: number | null;
  publishedAt: number | null;
}

export interface LearningRun {
  id: string;
  containerId: string;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  evidenceCount: number;
  proposedCount: number;
  createdAt: number;
  finishedAt: number | null;
}
