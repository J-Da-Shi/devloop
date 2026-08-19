import { DeviceRepository } from "./repositories/device-repository.js";

export class DevLoopRepository extends DeviceRepository {}

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
} from "./repositories/repository-types.js";
