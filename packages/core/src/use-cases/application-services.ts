import type { CoreUseCases } from "./contracts.js";

export interface ScanUseCase {
  readonly start: CoreUseCases["scan.start"];
  readonly status: CoreUseCases["scan.status"];
  readonly cancel: CoreUseCases["scan.cancel"];
}

export interface AssetQueryUseCase {
  readonly list: CoreUseCases["assets.list"];
  readonly get: CoreUseCases["assets.get"];
  readonly openSource: CoreUseCases["assets.openSource"];
  readonly disable: CoreUseCases["assets.disable"];
  readonly enable: CoreUseCases["assets.enable"];
}

export interface EffectiveConfigUseCase {
  readonly resolve: CoreUseCases["effective.resolve"];
}

export interface DiagnosticQueryUseCase {
  readonly list: CoreUseCases["diagnostics.list"];
  readonly export: CoreUseCases["diagnostics.export"];
}

export interface MigrationPreviewUseCase {
  readonly preview: CoreUseCases["migration.preview"];
}

export interface DeploymentUseCase {
  readonly execute: CoreUseCases["deployment.execute"];
  readonly rollback: CoreUseCases["deployment.rollback"];
}

export interface HistoryUseCase {
  readonly list: CoreUseCases["history.list"];
  readonly get: CoreUseCases["history.get"];
}

export interface SettingsUseCase {
  readonly get: CoreUseCases["settings.get"];
  readonly clearLocalData: CoreUseCases["settings.clearLocalData"];
  readonly update: CoreUseCases["settings.update"];
}

export interface ApplicationServices {
  readonly scan: ScanUseCase;
  readonly assets: AssetQueryUseCase;
  readonly effective: EffectiveConfigUseCase;
  readonly diagnostics: DiagnosticQueryUseCase;
  readonly migration: MigrationPreviewUseCase;
  readonly deployments: DeploymentUseCase;
  readonly history: HistoryUseCase;
  readonly settings: SettingsUseCase;
}

export function createCoreUseCases(services: ApplicationServices): CoreUseCases {
  return Object.freeze({
    "scan.start": services.scan.start,
    "scan.status": services.scan.status,
    "scan.cancel": services.scan.cancel,
    "assets.list": services.assets.list,
    "assets.get": services.assets.get,
    "assets.openSource": services.assets.openSource,
    "assets.disable": services.assets.disable,
    "assets.enable": services.assets.enable,
    "effective.resolve": services.effective.resolve,
    "diagnostics.list": services.diagnostics.list,
    "diagnostics.export": services.diagnostics.export,
    "migration.preview": services.migration.preview,
    "deployment.execute": services.deployments.execute,
    "deployment.rollback": services.deployments.rollback,
    "history.list": services.history.list,
    "history.get": services.history.get,
    "settings.get": services.settings.get,
    "settings.clearLocalData": services.settings.clearLocalData,
    "settings.update": services.settings.update,
  });
}
