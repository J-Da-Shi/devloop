import { ScratchpadRepository } from "./scratchpad-repository.js";

export class DevLoopRepository extends ScratchpadRepository {}

export type {
  AppliedRunApproval,
  ClaimedTask,
  EventfulResult,
  ProjectExecutionContext,
  PublishedRunApproval,
  RegisteredProjectInput,
  ResearchRunApproval,
  RunApplicationContext,
  RunApprovalContext,
  RunApprovalResult,
  RunPublishContext,
  StoredRunArtifact,
  StoredSkillDetails,
  StoredSkillVersionInput,
} from "./repository-types.js";
