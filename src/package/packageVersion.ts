/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  Connection,
  Lifecycle,
  Logger,
  Messages,
  PollingClient,
  sfdc,
  SfError,
  SfProject,
  StatusResult,
} from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { Optional } from '@salesforce/ts-types';
import { QueryResult } from 'jsforce';
import {
  PackageInstallCreateRequest,
  PackageInstallOptions,
  PackageSaveResult,
  PackageType,
  PackageVersionCreateOptions,
  PackageVersionCreateRequestQueryOptions,
  PackageVersionCreateRequestResult,
  PackageVersionEvents,
  PackageVersionOptions,
  PackageVersionReportResult,
  PackageVersionUpdateOptions,
  PackagingSObjects,
} from '../interfaces';
import {
  applyErrorAction,
  BY_LABEL,
  combineSaveErrors,
  escapeInstallationKey,
  getPackageAliasesFromId,
  getPackageIdFromAlias,
  massageErrorMessage,
  validateId,
} from '../utils';
import { PackageVersionCreate } from './packageVersionCreate';
import { getPackageVersionReport } from './packageVersionReport';
import { getCreatePackageVersionCreateRequestReport } from './packageVersionCreateRequestReport';
import { list } from './packageVersionCreateRequest';
import { getUninstallErrors, uninstallPackage } from './packageUninstall';
import {
  createPackageInstallRequest,
  getInstallationStatus,
  getStatus,
  isErrorFromSPVQueryRestriction,
  waitForPublish,
} from './packageInstall';
import Package2 = PackagingSObjects.Package2;

type Package2Version = PackagingSObjects.Package2Version;

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/packaging', 'package_version');
const installMsgs = Messages.loadMessages('@salesforce/packaging', 'package_install');

export const Package2VersionFields = [
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'Package2Id',
  'SubscriberPackageVersionId',
  'Tag',
  'Branch',
  'AncestorId',
  'ValidationSkipped',
  'Name',
  'Description',
  'MajorVersion',
  'MinorVersion',
  'PatchVersion',
  'BuildNumber',
  'IsDeprecated',
  'IsPasswordProtected',
  'CodeCoverage',
  'CodeCoveragePercentages',
  'HasPassedCodeCoverageCheck',
  'InstallKey',
  'IsReleased',
  'ConvertedFromVersionId',
  'ReleaseVersion',
  'BuildDurationInSeconds',
  'HasMetadataRemoved',
];

let logger: Logger;
const getLogger = (): Logger => {
  if (!logger) {
    logger = Logger.childFromRoot('package');
  }
  return logger;
};

export class PackageVersion {
  private readonly project: SfProject;
  private readonly connection: Connection;

  private data: Package2Version;
  private packageType: Optional<PackageType>;

  public constructor(private options: PackageVersionOptions) {
    this.connection = this.options.connection;
    this.project = this.options.project;
    this.data = {} as Package2Version;
    const id = this.resolveId();

    // validate ID
    if (id.startsWith('04t')) {
      validateId(BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID, id);
      this.data.SubscriberPackageVersionId = id;
    } else if (id.startsWith('05i')) {
      validateId(BY_LABEL.PACKAGE_VERSION_ID, id);
      this.data.Id = id;
    } else {
      throw messages.createError('errorInvalidPackageVersionId', [this.options.idOrAlias]);
    }
  }

  /**
   * Sends a request to create a new package version and optionally polls for
   * the status of the request until the package version is created or the
   * polling timeout is reached.
   *
   * @param options PackageVersionCreateOptions
   * @param polling frequency and timeout Durations to be used in polling
   * @returns PackageVersionCreateRequestResult
   */
  public static async create(
    options: PackageVersionCreateOptions,
    polling: { frequency: Duration; timeout: Duration } = {
      frequency: Duration.seconds(0),
      timeout: Duration.seconds(0),
    }
  ): Promise<Partial<PackageVersionCreateRequestResult>> {
    const pvc = new PackageVersionCreate({ ...options });
    const createResult = await pvc.createPackageVersion();

    return await PackageVersion.pollCreateStatus(createResult.Id, options.connection, options.project, polling).catch(
      (err: Error) => {
        // TODO
        // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
        throw applyErrorAction(massageErrorMessage(err));
      }
    );
  }

  /**
   * Gets current state of a package version create request.
   *
   * @param createPackageRequestId
   * @param connection
   */
  public static async getCreateStatus(
    createPackageRequestId: string,
    connection: Connection
  ): Promise<PackageVersionCreateRequestResult> {
    return await getCreatePackageVersionCreateRequestReport({
      createPackageVersionRequestId: createPackageRequestId,
      connection,
    }).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(massageErrorMessage(err));
    });
  }

  /**
   * Fetch a list of package version create requests based on the given options.
   *
   * @param connection connection to an org
   * @param options PackageVersionCreateRequestQueryOptions
   * @returns the list of package version create requests.
   */
  public static async getPackageVersionCreateRequests(
    connection: Connection,
    options?: PackageVersionCreateRequestQueryOptions
  ): Promise<PackageVersionCreateRequestResult[]> {
    return list({ ...options, connection });
  }

  /**
   * Convenience function that will wait for a package version to be created.
   *
   * This function emits LifeCycle events, "enqueued", "in-progress", "success", "error" and "timed-out" to
   * progress and current status. Events also carry a payload of type PackageVersionCreateRequestResult.
   *
   * @param createPackageVersionRequestId
   * @param polling frequency and timeout Durations to be used in polling
   * */
  public static async pollCreateStatus(
    createPackageVersionRequestId: string,
    connection: Connection,
    project: SfProject,
    polling: { frequency: Duration; timeout: Duration }
  ): Promise<PackageVersionCreateRequestResult> {
    if (polling.timeout?.milliseconds <= 0) {
      return this.getCreateStatus(createPackageVersionRequestId, connection);
    }
    let remainingWaitTime: Duration = polling.timeout;
    let report: PackageVersionCreateRequestResult;
    const pollingClient = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        report = await this.getCreateStatus(createPackageVersionRequestId, connection);
        switch (report.Status) {
          case 'Queued':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.enqueued, { ...report, remainingWaitTime });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'InProgress':
          case 'Initializing':
          case 'VerifyingFeaturesAndSettings':
          case 'VerifyingDependencies':
          case 'VerifyingMetadata':
          case 'FinalizingPackageVersion':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.progress, {
              ...report,
              remainingWaitTime,
            });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'Success': {
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.success, report);
            const packageVersion = new PackageVersion({
              connection,
              project,
              idOrAlias: report.Package2VersionId,
            });
            await packageVersion.updateProjectWithPackageVersion(report);
            return { completed: true, payload: report };
          }
          case 'Error':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.error, report);
            return { completed: true, payload: report };
        }
      },

      frequency: polling.frequency,
      timeout: polling.timeout,
    });

    try {
      return pollingClient.subscribe<PackageVersionCreateRequestResult>();
    } catch (err) {
      await Lifecycle.getInstance().emit(PackageVersionEvents.create['timed-out'], report);
      throw applyErrorAction(err as Error);
    }
  }

  /**
   * Reports on the progress of a package version uninstall.
   *
   * @param id the 06y package version uninstall request id
   * @param connection
   */
  public static async uninstallReport(
    id: string,
    connection: Connection
  ): Promise<PackagingSObjects.SubscriberPackageVersionUninstallRequest> {
    if (!id.startsWith('06y') || !sfdc.validateSalesforceId(id)) {
      throw messages.createError('packageVersionUninstallRequestIdInvalid', [id]);
    }
    const result = (await connection.tooling.retrieve(
      'SubscriberPackageVersionUninstallRequest',
      id
    )) as PackagingSObjects.SubscriberPackageVersionUninstallRequest;
    if (result.Status === 'Error') {
      const errorDetails = await getUninstallErrors(connection, id);
      const errors = errorDetails.map((record, index) => `(${index + 1}) ${record.Message}`);
      const errHeader = errors.length > 0 ? `\n=== Errors\n${errors.join('\n')}` : '';
      const err = messages.getMessage('defaultErrorMessage', [id, result.Id]);

      throw new SfError(`${err}${errHeader}`, 'UNINSTALL_ERROR', [messages.getMessage('action')]);
    }
    return result;
  }

  /**
   * Gets current state of a package version create request.
   *
   * @param createPackageRequestId
   * @param connection
   */
  public static async getCreateVersionReport(
    createPackageRequestId: string,
    connection: Connection
  ): Promise<PackageVersionCreateRequestResult> {
    return await getCreatePackageVersionCreateRequestReport({
      createPackageVersionRequestId: createPackageRequestId,
      connection,
    }).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(massageErrorMessage(err));
    });
  }
  /**
   * Convenience function that will wait for a package version to be created.
   *
   * This function emits LifeCycle events, "enqueued", "in-progress", "success", "error" and "timed-out" to
   * progress and current status. Events also carry a payload of type PackageVersionCreateRequestResult.
   *
   * @param createPackageVersionRequestId
   * @param project
   * @param connection
   * @param polling frequency and timeout Durations to be used in polling
   * */
  public static async waitForCreateVersion(
    createPackageVersionRequestId: string,
    project: SfProject,
    connection: Connection,
    polling: { frequency: Duration; timeout: Duration }
  ): Promise<PackageVersionCreateRequestResult> {
    if (polling.timeout?.milliseconds <= 0) {
      return await PackageVersion.getCreateVersionReport(createPackageVersionRequestId, connection);
    }
    let remainingWaitTime: Duration = polling.timeout;
    let report: PackageVersionCreateRequestResult;
    const pollingClient = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        report = await this.getCreateVersionReport(createPackageVersionRequestId, connection);
        switch (report.Status) {
          case 'Queued':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.enqueued, { ...report, remainingWaitTime });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'InProgress':
          case 'Initializing':
          case 'VerifyingFeaturesAndSettings':
          case 'VerifyingDependencies':
          case 'VerifyingMetadata':
          case 'FinalizingPackageVersion':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.progress, {
              ...report,
              remainingWaitTime,
            });
            remainingWaitTime = Duration.seconds(remainingWaitTime.seconds - polling.frequency.seconds);
            return {
              completed: false,
              payload: report,
            };
          case 'Success':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.success, report);
            await new PackageVersion({
              idOrAlias: report.SubscriberPackageVersionId,
              project,
              connection,
            }).updateProjectWithPackageVersion(report);
            return { completed: true, payload: report };
          case 'Error':
            await Lifecycle.getInstance().emit(PackageVersionEvents.create.error, report);
            return { completed: true, payload: report };
        }
      },
      frequency: polling.frequency,
      timeout: polling.timeout,
    });
    try {
      return pollingClient.subscribe<PackageVersionCreateRequestResult>();
    } catch (err) {
      await Lifecycle.getInstance().emit(PackageVersionEvents.create['timed-out'], report);
      throw applyErrorAction(err as Error);
    }
  }

  /**
   * Retrieves the package version create request.
   *
   * @param installRequestId
   * @param connection
   */
  public static async getInstallRequest(
    installRequestId: string,
    connection: Connection
  ): Promise<PackagingSObjects.PackageInstallRequest> {
    if (!installRequestId.startsWith('0Hf') || !sfdc.validateSalesforceId(installRequestId)) {
      throw messages.createError('packageVersionInstallRequestIdInvalid', [installRequestId]);
    }
    const installRequest = await getStatus(connection, installRequestId);
    if (!installRequest) {
      throw messages.createError('packageVersionInstallRequestNotFound', [installRequestId]);
    }
    return installRequest;
  }
  /**
   * Get the package version ID for this PackageVersion.
   *
   * @returns The PackageVersionId (05i).
   */
  public async getId(): Promise<string> {
    if (!this.data.Id) {
      await this.getPackageVersionData();
    }
    return this.data.Id;
  }

  /**
   * Get the subscriber package version ID for this PackageVersion.
   *
   * @returns The SubscriberPackageVersionId (04t).
   */
  public async getSubscriberId(): Promise<string> {
    if (!this.data.SubscriberPackageVersionId) {
      await this.getPackageVersionData();
    }
    return this.data.SubscriberPackageVersionId;
  }

  public async getPackageId(): Promise<string> {
    if (!this.data.Package2Id) {
      await this.getPackageVersionData();
    }
    return this.data.Package2Id;
  }

  public async getPackageType(): Promise<PackageType> {
    if (!this.packageType) {
      this.packageType = (
        await this.connection.singleRecordQuery<Package2>(
          `select ContainerOptions from Package2 where Id = '${await this.getPackageId()}' limit 1`,
          { tooling: true }
        )
      ).ContainerOptions;
    }

    return this.packageType;
  }

  /**
   * Get the Package2Version SObject data for this PackageVersion.
   *
   * @param force force a refresh of the package version data.
   * @returns Package2Version
   */
  public async getPackageVersionData(force = false): Promise<Package2Version> {
    if (!this.data.Name || force) {
      let queryConfig: { id: string; clause: string; label1: string; label2: string };
      if (this.data.Id) {
        queryConfig = {
          id: this.data.Id,
          clause: `Id = '${this.data.Id}'`,
          label1: BY_LABEL.PACKAGE_VERSION_ID.label,
          label2: BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID.label,
        };
      } else {
        queryConfig = {
          id: this.data.SubscriberPackageVersionId,
          clause: `SubscriberPackageVersionId = '${this.data.SubscriberPackageVersionId}'`,
          label1: BY_LABEL.SUBSCRIBER_PACKAGE_VERSION_ID.label,
          label2: BY_LABEL.PACKAGE_VERSION_ID.label,
        };
      }
      const allFields = Package2VersionFields.toString();
      const query = `SELECT ${allFields} FROM Package2Version WHERE ${queryConfig.clause} LIMIT 1`;
      try {
        this.data = await this.connection.singleRecordQuery<Package2Version>(query, { tooling: true });
      } catch (err) {
        throw messages.createError(
          'errorInvalidIdNoMatchingVersionId',
          [queryConfig.label1, queryConfig.id, queryConfig.label2],
          undefined,
          err as Error
        );
      }
    }
    return this.data;
  }

  /**
   * Deletes this PackageVersion.
   */
  public async delete(): Promise<PackageSaveResult> {
    return this.updateDeprecation(true);
  }

  /**
   * Undeletes this PackageVersion.
   */
  public async undelete(): Promise<PackageSaveResult> {
    return this.updateDeprecation(false);
  }

  /**
   * Reports details about this PackageVersion.
   *
   * @param verbose Whether to get a detailed version of the report, at the expense of performance.
   */
  public async report(verbose = false): Promise<PackageVersionReportResult> {
    const packageVersionId = await this.getId();
    const results = await getPackageVersionReport({
      packageVersionId,
      connection: this.connection,
      project: this.project,
      verbose,
    }).catch((err: Error) => {
      // TODO
      // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
      throw applyErrorAction(massageErrorMessage(err));
    });
    return results[0];
  }

  /**
   * Installs a package version in a subscriber org.
   *
   * Package Version install emits the following events:
   * - PackageEvents.install.warning
   * - PackageEvents.install.presend
   * - PackageEvents.install.postsend
   * - PackageEvents.install['subscriber-status']
   *
   * @param pkgInstallCreateRequest
   * @param options
   */
  public async install(
    pkgInstallCreateRequest: PackageInstallCreateRequest,
    options?: PackageInstallOptions
  ): Promise<PackagingSObjects.PackageInstallRequest> {
    await this.waitForPublish(pkgInstallCreateRequest, options);
    const pkgVersionInstallRequest = await createPackageInstallRequest(
      this.connection,
      pkgInstallCreateRequest,
      await this.getPackageType()
    );
    return this.getInstallStatus(pkgVersionInstallRequest.Id, pkgInstallCreateRequest.Password, options);
  }

  /**
   * Fetches the status of a package version install request and will wait for the install to complete, if requested
   * Package Version install emits the following events:
   * - PackageEvents.install['subscriber-status']
   *
   * @param packageInstallRequestOrId
   * @param installationKey
   * @param options
   */
  public async getInstallStatus(
    packageInstallRequestOrId: string | PackagingSObjects.PackageInstallRequest,
    installationKey?: string,
    options?: PackageInstallOptions
  ): Promise<PackagingSObjects.PackageInstallRequest> {
    const id = typeof packageInstallRequestOrId === 'string' ? packageInstallRequestOrId : packageInstallRequestOrId.Id;
    const packageInstallRequest =
      typeof packageInstallRequestOrId === 'string' ? await getStatus(this.connection, id) : packageInstallRequestOrId;
    if (!options || options.pollingTimeout <= 0) {
      return packageInstallRequest;
    } else {
      const pollingFrequency = options.pollingFrequency || Duration.milliseconds(10000);
      await waitForPublish(
        this.connection,
        packageInstallRequest.SubscriberPackageVersionKey,
        pollingFrequency,
        options.pollingTimeout,
        packageInstallRequest.Password
      );
      return getStatus(this.connection, id);
    }
  }

  public async uninstall(
    frequency: Duration = Duration.milliseconds(0),
    wait: Duration = Duration.milliseconds(0)
  ): Promise<PackagingSObjects.SubscriberPackageVersionUninstallRequest> {
    return await uninstallPackage(await this.getSubscriberId(), this.connection, frequency, wait);
  }

  public async promote(): Promise<PackageSaveResult> {
    const id = await this.getId();
    return this.options.connection.tooling.update('Package2Version', { IsReleased: true, Id: id });
  }

  public async update(options: PackageVersionUpdateOptions): Promise<PackageSaveResult> {
    const id = await this.getId();

    const request = {
      Id: id,
      InstallKey: options.InstallKey,
      Name: options.VersionName,
      Description: options.VersionDescription,
      Branch: options.Branch,
      Tag: options.Tag,
    };

    // filter out any undefined values and their keys
    Object.keys(request).forEach((key) => request[key] === undefined && delete request[key]);

    const result = await this.connection.tooling.update('Package2Version', request);
    if (!result.success) {
      throw new Error(result.errors.join(', '));
    }
    // Use the 04t ID for the success message
    result.id = await this.getSubscriberId();
    return result;
  }

  /**
   * Creates a new package version.
   *
   * @param options
   * @param polling frequency and timeout Durations to be used in polling
   */
  public async create(
    options: PackageVersionCreateOptions,
    polling: { frequency: Duration; timeout: Duration } = {
      frequency: Duration.seconds(0),
      timeout: Duration.seconds(0),
    }
  ): Promise<Partial<PackageVersionCreateRequestResult>> {
    const pvc = new PackageVersionCreate({ ...options, ...this.options });
    const createResult = await pvc.createPackageVersion();

    if (polling.timeout?.milliseconds > 0) {
      return await PackageVersion.waitForCreateVersion(createResult.Id, this.project, this.connection, polling).catch(
        (err: Error) => {
          // TODO
          // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
          throw applyErrorAction(massageErrorMessage(err));
        }
      );
    }
    return createResult;
  }

  /**
   * Returns an array of RSS and CSP external sites for the package.
   *
   * @param installationKey The installation key (if any) for the subscriber package version.
   * @returns an array of RSS and CSP site URLs, or undefined if the package doesn't have any.
   */
  public async getExternalSites(installationKey?: string): Promise<Optional<string[]>> {
    const queryNoKey = `SELECT RemoteSiteSettings, CspTrustedSites FROM SubscriberPackageVersion WHERE Id ='${await this.getSubscriberId()}'`;

    let queryResult: QueryResult<PackagingSObjects.SubscriberPackageVersion>;
    try {
      const escapedInstallationKey = installationKey ? escapeInstallationKey(installationKey) : null;
      const queryWithKey = `${queryNoKey} AND InstallationKey ='${escapedInstallationKey}'`;
      getLogger().debug(`Checking package: [${await this.getPackageId()}] for external sites`);
      queryResult = await this.connection.tooling.query<PackagingSObjects.SubscriberPackageVersion>(queryWithKey);
    } catch (e) {
      // First check for Implementation Restriction error that is enforced in 214, before it was possible to query
      // against InstallationKey, otherwise surface the error.
      if (e instanceof Error && isErrorFromSPVQueryRestriction(e)) {
        queryResult = await this.connection.tooling.query<PackagingSObjects.SubscriberPackageVersion>(queryNoKey);
      } else {
        throw e;
      }
    }

    if (queryResult?.records?.length > 0) {
      const record = queryResult.records[0];
      const rssUrls = record.RemoteSiteSettings.settings.map((rss) => rss.url);
      const cspUrls = record.CspTrustedSites.settings.map((csp) => csp.endpointUrl);

      const sites = [...rssUrls, ...cspUrls];
      if (sites.length) {
        return sites;
      }
    }
  }

  private async updateDeprecation(isDeprecated: boolean): Promise<PackageSaveResult> {
    const id = await this.getId();

    // setup the request
    const request: { Id: string; IsDeprecated: boolean } = {
      Id: id,
      IsDeprecated: isDeprecated,
    };

    const updateResult = await this.connection.tooling.update('Package2Version', request);
    if (!updateResult.success) {
      throw combineSaveErrors('Package2', 'update', updateResult.errors);
    }
    updateResult.id = await this.getSubscriberId();
    return updateResult;
  }

  private async updateProjectWithPackageVersion(results: PackageVersionCreateRequestResult): Promise<void> {
    if (!process.env.SFDX_PROJECT_AUTOUPDATE_DISABLE_FOR_PACKAGE_VERSION_CREATE) {
      // get the newly created package version from the server
      const versionResult = (
        await this.connection.tooling.query<{
          Branch: string;
          MajorVersion: string;
          MinorVersion: string;
          PatchVersion: string;
          BuildNumber: string;
        }>(
          `SELECT Branch, MajorVersion, MinorVersion, PatchVersion, BuildNumber FROM Package2Version WHERE SubscriberPackageVersionId='${results.SubscriberPackageVersionId}'`
        )
      ).records[0];
      const version = `${getPackageAliasesFromId(results.Package2Id, this.project).join()}@${
        versionResult.MajorVersion ?? 0
      }.${versionResult.MinorVersion ?? 0}.${versionResult.PatchVersion ?? 0}`;
      const build = versionResult.BuildNumber ? `-${versionResult.BuildNumber}` : '';
      const branch = versionResult.Branch ? `-${versionResult.Branch}` : '';
      // set packageAliases entry '<package>@<major>.<minor>.<patch>-<build>-<branch>: <result.subscriberPackageVersionId>'
      this.project.getSfProjectJson().getContents().packageAliases[`${version}${build}${branch}`] =
        results.SubscriberPackageVersionId;
      await this.project.getSfProjectJson().write();
    }
  }
  private resolveId(): string {
    return getPackageIdFromAlias(this.options.idOrAlias, this.project);
  }

  private async waitForPublish(
    pkgInstallCreateRequest: PackageInstallCreateRequest,
    options: PackageInstallOptions
  ): Promise<void> {
    if (options?.publishTimeout > Duration.milliseconds(0)) {
      await waitForPublish(
        this.connection,
        pkgInstallCreateRequest.SubscriberPackageVersionKey,
        options.pollingFrequency,
        options.publishTimeout,
        pkgInstallCreateRequest.Password
      );
    } else {
      try {
        const result = await getInstallationStatus(
          pkgInstallCreateRequest.SubscriberPackageVersionKey,
          pkgInstallCreateRequest.Password,
          this.connection
        );
        if (result?.records.length === 0 || result?.records[0].InstallValidationStatus === 'PACKAGE_UNAVAILABLE') {
          throw installMsgs.createError('subscriberPackageVersionNotPublished');
        }
      } catch (e) {
        // TODO
        // until package2 is GA, wrap perm-based errors w/ 'contact sfdc' action (REMOVE once package2 is GA'd)
        throw applyErrorAction(massageErrorMessage(e as Error));
      }
    }
  }
}
