import * as clc from "cli-color";

import { Executor } from "./executor";
import { FirebaseError } from "../../../error";
import { SourceTokenScraper } from "./sourceTokenScraper";
import { Timer } from "./timer";
import { assertExhaustive } from "../../../functional";
import { getHumanFriendlyRuntimeName } from "../runtimes";
import { functionsOrigin, functionsV2Origin } from "../../../api";
import { logger } from "../../../logger";
import * as backend from "../backend";
import * as cloudtasks from "../../../gcp/cloudtasks";
import * as deploymentTool from "../../../deploymentTool";
import * as gcf from "../../../gcp/cloudfunctions";
import * as gcfV2 from "../../../gcp/cloudfunctionsv2";
import * as helper from "../functionsDeployHelper";
import * as planner from "./planner";
import * as poller from "../../../operation-poller";
import * as pubsub from "../../../gcp/pubsub";
import * as reporter from "./reporter";
import * as run from "../../../gcp/run";
import * as scheduler from "../../../gcp/cloudscheduler";
import * as utils from "../../../utils";
import * as services from "../services";
import { AUTH_BLOCKING_EVENTS } from "../../../functions/events/v1";

// TODO: Tune this for better performance.
const gcfV1PollerOptions: Omit<poller.OperationPollerOptions, "operationResourceName"> = {
  apiOrigin: functionsOrigin,
  apiVersion: gcf.API_VERSION,
  masterTimeout: 25 * 60 * 1_000, // 25 minutes is the maximum build time for a function
  maxBackoff: 10_000,
};

const gcfV2PollerOptions: Omit<poller.OperationPollerOptions, "operationResourceName"> = {
  apiOrigin: functionsV2Origin,
  apiVersion: gcfV2.API_VERSION,
  masterTimeout: 25 * 60 * 1_000, // 25 minutes is the maximum build time for a function
  maxBackoff: 10_000,
};

const DEFAULT_GCFV2_CONCURRENCY = 80;

export interface FabricatorArgs {
  executor: Executor;
  functionExecutor: Executor;
  appEngineLocation: string;

  // Required if creating or updating any GCFv1 functions
  sourceUrl?: string;

  // Required if creating or updating any GCFv2 functions
  storage?: Record<string, gcfV2.StorageSource>;
}

const rethrowAs =
  <T>(endpoint: backend.Endpoint, op: reporter.OperationType) =>
  (err: unknown): T => {
    logger.error((err as Error).message);
    throw new reporter.DeploymentError(endpoint, op, err);
  };

/** Fabricators make a customer's backend match a spec by applying a plan. */
export class Fabricator {
  executor: Executor;
  functionExecutor: Executor;
  sourceUrl: string | undefined;
  storage: Record<string, gcfV2.StorageSource> | undefined;
  appEngineLocation: string;
  triggerQueue: Promise<void>;

  constructor(args: FabricatorArgs) {
    this.executor = args.executor;
    this.functionExecutor = args.functionExecutor;
    this.sourceUrl = args.sourceUrl;
    this.storage = args.storage;
    this.appEngineLocation = args.appEngineLocation;
    this.triggerQueue = Promise.resolve();
  }

  async applyPlan(plan: planner.DeploymentPlan): Promise<reporter.Summary> {
    const timer = new Timer();
    const summary: reporter.Summary = {
      totalTime: 0,
      results: [],
    };
    const deployChangesets = Object.values(plan).map(async (changes): Promise<void> => {
      const results = await this.applyChangeset(changes);
      summary.results.push(...results);
      return;
    });
    const promiseResults = await utils.allSettled(deployChangesets);

    const errs = promiseResults
      .filter((r) => r.status === "rejected")
      .map((r) => (r as utils.PromiseRejectedResult).reason);
    if (errs.length) {
      logger.debug(
        "Fabricator.applyRegionalChanges returned an unhandled exception. This should never happen",
        JSON.stringify(errs, null, 2)
      );
    }

    summary.totalTime = timer.stop();
    return summary;
  }

  async applyChangeset(changes: planner.Changeset): Promise<Array<reporter.DeployResult>> {
    const deployResults: reporter.DeployResult[] = [];
    const handle = async (
      op: reporter.OperationType,
      endpoint: backend.Endpoint,
      fn: () => Promise<void>
    ): Promise<void> => {
      const timer = new Timer();
      const result: Partial<reporter.DeployResult> = { endpoint };
      try {
        await fn();
        this.logOpSuccess(op, endpoint);
      } catch (err: any) {
        result.error = err as Error;
      }
      result.durationMs = timer.stop();
      deployResults.push(result as reporter.DeployResult);
    };

    const upserts: Array<Promise<void>> = [];
    const scraper = new SourceTokenScraper();
    for (const endpoint of changes.endpointsToCreate) {
      this.logOpStart("creating", endpoint);
      upserts.push(handle("create", endpoint, () => this.createEndpoint(endpoint, scraper)));
    }
    for (const update of changes.endpointsToUpdate) {
      this.logOpStart("updating", update.endpoint);
      upserts.push(handle("update", update.endpoint, () => this.updateEndpoint(update, scraper)));
    }
    await utils.allSettled(upserts);

    // Note: every promise is generated by handle which records error in results.
    // We've used hasErrors as a cheater here instead of viewing the results of allSettled
    if (deployResults.find((r) => r.error)) {
      for (const endpoint of changes.endpointsToDelete) {
        deployResults.push({
          endpoint,
          durationMs: 0,
          error: new reporter.AbortedDeploymentError(endpoint),
        });
      }
      return deployResults;
    }

    const deletes: Array<Promise<void>> = [];
    for (const endpoint of changes.endpointsToDelete) {
      this.logOpStart("deleting", endpoint);
      deletes.push(handle("delete", endpoint, () => this.deleteEndpoint(endpoint)));
    }
    await utils.allSettled(deletes);

    return deployResults;
  }

  async createEndpoint(endpoint: backend.Endpoint, scraper: SourceTokenScraper): Promise<void> {
    endpoint.labels = { ...endpoint.labels, ...deploymentTool.labels() };
    if (endpoint.platform === "gcfv1") {
      await this.createV1Function(endpoint, scraper);
    } else if (endpoint.platform === "gcfv2") {
      await this.createV2Function(endpoint);
    } else {
      assertExhaustive(endpoint.platform);
    }

    await this.setTrigger(endpoint, false);
  }

  async updateEndpoint(update: planner.EndpointUpdate, scraper: SourceTokenScraper): Promise<void> {
    update.endpoint.labels = { ...update.endpoint.labels, ...deploymentTool.labels() };
    if (update.deleteAndRecreate) {
      await this.deleteEndpoint(update.deleteAndRecreate);
      await this.createEndpoint(update.endpoint, scraper);
      return;
    }

    if (update.endpoint.platform === "gcfv1") {
      await this.updateV1Function(update.endpoint, scraper);
    } else if (update.endpoint.platform === "gcfv2") {
      await this.updateV2Function(update.endpoint);
    } else {
      assertExhaustive(update.endpoint.platform);
    }

    await this.setTrigger(update.endpoint, true);
  }

  async deleteEndpoint(endpoint: backend.Endpoint): Promise<void> {
    await this.deleteTrigger(endpoint);
    if (endpoint.platform === "gcfv1") {
      await this.deleteV1Function(endpoint);
    } else {
      await this.deleteV2Function(endpoint);
    }
  }

  async createV1Function(endpoint: backend.Endpoint, scraper: SourceTokenScraper): Promise<void> {
    if (!this.sourceUrl) {
      logger.debug("Precondition failed. Cannot create a GCF function without sourceUrl");
      throw new Error("Precondition failed");
    }
    const apiFunction = gcf.functionFromEndpoint(endpoint, this.sourceUrl);
    // As a general security practice and way to smooth out the upgrade path
    // for GCF gen 2, we are enforcing that all new GCFv1 deploys will require
    // HTTPS
    if (apiFunction.httpsTrigger) {
      apiFunction.httpsTrigger.securityLevel = "SECURE_ALWAYS";
    }
    apiFunction.sourceToken = await scraper.tokenPromise();
    const resultFunction = await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcf.createFunction(apiFunction);
        return poller.pollOperation<gcf.CloudFunction>({
          ...gcfV1PollerOptions,
          pollerName: `create-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
          onPoll: scraper.poller,
        });
      })
      .catch(rethrowAs(endpoint, "create"));

    endpoint.uri = resultFunction?.httpsTrigger?.url;
    if (backend.isHttpsTriggered(endpoint)) {
      const invoker = endpoint.httpsTrigger.invoker || ["public"];
      if (!invoker.includes("private")) {
        await this.executor
          .run(async () => {
            await gcf.setInvokerCreate(endpoint.project, backend.functionName(endpoint), invoker);
          })
          .catch(rethrowAs(endpoint, "set invoker"));
      }
    } else if (backend.isCallableTriggered(endpoint)) {
      // Callable functions should always be public
      await this.executor
        .run(async () => {
          await gcf.setInvokerCreate(endpoint.project, backend.functionName(endpoint), ["public"]);
        })
        .catch(rethrowAs(endpoint, "set invoker"));
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      // Like HTTPS triggers, taskQueueTriggers have an invoker, but unlike HTTPS they don't default
      // public.
      const invoker = endpoint.taskQueueTrigger.invoker;
      if (invoker && !invoker.includes("private")) {
        await this.executor
          .run(async () => {
            await gcf.setInvokerCreate(endpoint.project, backend.functionName(endpoint), invoker);
          })
          .catch(rethrowAs(endpoint, "set invoker"));
      }
    } else if (
      backend.isBlockingTriggered(endpoint) &&
      AUTH_BLOCKING_EVENTS.includes(endpoint.blockingTrigger.eventType as any)
    ) {
      // Auth Blocking functions should always be public
      await this.executor
        .run(async () => {
          await gcf.setInvokerCreate(endpoint.project, backend.functionName(endpoint), ["public"]);
        })
        .catch(rethrowAs(endpoint, "set invoker"));
    }
  }

  async createV2Function(endpoint: backend.Endpoint): Promise<void> {
    if (!this.storage) {
      logger.debug("Precondition failed. Cannot create a GCFv2 function without storage");
      throw new Error("Precondition failed");
    }
    const apiFunction = gcfV2.functionFromEndpoint(endpoint, this.storage[endpoint.region]);

    // N.B. As of GCFv2 private preview GCF no longer creates Pub/Sub topics
    // for Pub/Sub event handlers. This may change, at which point this code
    // could be deleted.
    const topic = apiFunction.eventTrigger?.pubsubTopic;
    if (topic) {
      await this.executor
        .run(async () => {
          try {
            await pubsub.createTopic({ name: topic });
          } catch (err: any) {
            // Pub/Sub uses HTTP 409 (CONFLICT) with a status message of
            // ALREADY_EXISTS if the topic already exists.
            if (err.status === 409) {
              return;
            }
            throw new FirebaseError("Unexpected error creating Pub/Sub topic", {
              original: err as Error,
            });
          }
        })
        .catch(rethrowAs(endpoint, "create topic"));
    }

    const resultFunction = await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcfV2.createFunction(apiFunction);
        return await poller.pollOperation<gcfV2.CloudFunction>({
          ...gcfV2PollerOptions,
          pollerName: `create-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
        });
      })
      .catch(rethrowAs(endpoint, "create"));

    endpoint.uri = resultFunction.serviceConfig.uri;
    const serviceName = resultFunction.serviceConfig.service!;
    if (backend.isHttpsTriggered(endpoint)) {
      const invoker = endpoint.httpsTrigger.invoker || ["public"];
      if (!invoker.includes("private")) {
        await this.executor
          .run(() => run.setInvokerCreate(endpoint.project, serviceName, invoker))
          .catch(rethrowAs(endpoint, "set invoker"));
      }
    } else if (backend.isCallableTriggered(endpoint)) {
      // Callable functions should always be public
      await this.executor
        .run(() => run.setInvokerCreate(endpoint.project, serviceName, ["public"]))
        .catch(rethrowAs(endpoint, "set invoker"));
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      // Like HTTPS triggers, taskQueueTriggers have an invoker, but unlike HTTPS they don't default
      // public.
      const invoker = endpoint.taskQueueTrigger.invoker;
      if (invoker && !invoker.includes("private")) {
        await this.executor
          .run(async () => {
            await run.setInvokerCreate(endpoint.project, serviceName, invoker);
          })
          .catch(rethrowAs(endpoint, "set invoker"));
      }
    } else if (
      backend.isBlockingTriggered(endpoint) &&
      AUTH_BLOCKING_EVENTS.includes(endpoint.blockingTrigger.eventType as any)
    ) {
      // Auth Blocking functions should always be public
      await this.executor
        .run(() => run.setInvokerCreate(endpoint.project, serviceName, ["public"]))
        .catch(rethrowAs(endpoint, "set invoker"));
    }

    const mem = endpoint.availableMemoryMb || backend.DEFAULT_MEMORY;
    if (mem >= backend.MIN_MEMORY_FOR_CONCURRENCY && endpoint.concurrency !== 1) {
      await this.setConcurrency(
        endpoint,
        serviceName,
        endpoint.concurrency || DEFAULT_GCFV2_CONCURRENCY
      );
    }
  }

  async updateV1Function(endpoint: backend.Endpoint, scraper: SourceTokenScraper): Promise<void> {
    if (!this.sourceUrl) {
      logger.debug("Precondition failed. Cannot update a GCF function without sourceUrl");
      throw new Error("Precondition failed");
    }
    const apiFunction = gcf.functionFromEndpoint(endpoint, this.sourceUrl);
    apiFunction.sourceToken = await scraper.tokenPromise();
    const resultFunction = await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcf.updateFunction(apiFunction);
        return await poller.pollOperation<gcf.CloudFunction>({
          ...gcfV1PollerOptions,
          pollerName: `update-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
          onPoll: scraper.poller,
        });
      })
      .catch(rethrowAs(endpoint, "update"));

    endpoint.uri = resultFunction?.httpsTrigger?.url;
    let invoker: string[] | undefined;
    if (backend.isHttpsTriggered(endpoint)) {
      invoker = endpoint.httpsTrigger.invoker;
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      invoker = endpoint.taskQueueTrigger.invoker;
    } else if (
      backend.isBlockingTriggered(endpoint) &&
      AUTH_BLOCKING_EVENTS.includes(endpoint.blockingTrigger.eventType as any)
    ) {
      invoker = ["public"];
    }
    if (invoker) {
      await this.executor
        .run(() => gcf.setInvokerUpdate(endpoint.project, backend.functionName(endpoint), invoker!))
        .catch(rethrowAs(endpoint, "set invoker"));
    }
  }

  async updateV2Function(endpoint: backend.Endpoint): Promise<void> {
    if (!this.storage) {
      logger.debug("Precondition failed. Cannot update a GCFv2 function without storage");
      throw new Error("Precondition failed");
    }
    const apiFunction = gcfV2.functionFromEndpoint(endpoint, this.storage[endpoint.region]);

    // N.B. As of GCFv2 private preview the API chokes on any update call that
    // includes the pub/sub topic even if that topic is unchanged.
    // We know that the user hasn't changed the topic between deploys because
    // of checkForInvalidChangeOfTrigger().
    if (apiFunction.eventTrigger?.pubsubTopic) {
      delete apiFunction.eventTrigger.pubsubTopic;
    }

    const resultFunction = await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcfV2.updateFunction(apiFunction);
        return await poller.pollOperation<gcfV2.CloudFunction>({
          ...gcfV2PollerOptions,
          pollerName: `update-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
        });
      })
      .catch(rethrowAs(endpoint, "update"));

    endpoint.uri = resultFunction.serviceConfig.uri;
    const serviceName = resultFunction.serviceConfig.service!;
    let invoker: string[] | undefined;
    if (backend.isHttpsTriggered(endpoint)) {
      invoker = endpoint.httpsTrigger.invoker;
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      invoker = endpoint.taskQueueTrigger.invoker;
    } else if (
      backend.isBlockingTriggered(endpoint) &&
      AUTH_BLOCKING_EVENTS.includes(endpoint.blockingTrigger.eventType as any)
    ) {
      invoker = ["public"];
    }
    if (invoker) {
      await this.executor
        .run(() => run.setInvokerUpdate(endpoint.project, serviceName, invoker!))
        .catch(rethrowAs(endpoint, "set invoker"));
    }

    if (endpoint.concurrency) {
      await this.setConcurrency(endpoint, serviceName, endpoint.concurrency);
    }
  }

  async deleteV1Function(endpoint: backend.Endpoint): Promise<void> {
    const fnName = backend.functionName(endpoint);
    await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcf.deleteFunction(fnName);
        const pollerOptions = {
          ...gcfV1PollerOptions,
          pollerName: `delete-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
        };
        await poller.pollOperation<void>(pollerOptions);
      })
      .catch(rethrowAs(endpoint, "delete"));
  }

  async deleteV2Function(endpoint: backend.Endpoint): Promise<void> {
    const fnName = backend.functionName(endpoint);
    await this.functionExecutor
      .run(async () => {
        const op: { name: string } = await gcfV2.deleteFunction(fnName);
        const pollerOptions = {
          ...gcfV2PollerOptions,
          pollerName: `delete-${endpoint.region}-${endpoint.id}`,
          operationResourceName: op.name,
        };
        await poller.pollOperation<void>(pollerOptions);
      })
      .catch(rethrowAs(endpoint, "delete"));
  }

  async setConcurrency(
    endpoint: backend.Endpoint,
    serviceName: string,
    concurrency: number
  ): Promise<void> {
    await this.functionExecutor
      .run(async () => {
        const service = await run.getService(serviceName);
        if (service.spec.template.spec.containerConcurrency === concurrency) {
          logger.debug("Skipping setConcurrency on", serviceName, " because it already matches");
          return;
        }

        delete service.status;
        delete (service.spec.template.metadata as any).name;
        service.spec.template.spec.containerConcurrency = concurrency;
        await run.replaceService(serviceName, service);
      })
      .catch(rethrowAs(endpoint, "set concurrency"));
  }

  // Set/Delete trigger is responsible for wiring up a function with any trigger not owned
  // by the GCF API. This includes schedules, task queues, and blocking function triggers.
  async setTrigger(endpoint: backend.Endpoint, update: boolean): Promise<void> {
    if (backend.isScheduleTriggered(endpoint)) {
      if (endpoint.platform === "gcfv1") {
        await this.upsertScheduleV1(endpoint);
        return;
      } else if (endpoint.platform === "gcfv2") {
        await this.upsertScheduleV2(endpoint);
        return;
      }
      assertExhaustive(endpoint.platform);
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      await this.upsertTaskQueue(endpoint);
    } else if (backend.isBlockingTriggered(endpoint)) {
      await this.registerBlockingTrigger(endpoint, update);
    }
  }

  async deleteTrigger(endpoint: backend.Endpoint): Promise<void> {
    if (backend.isScheduleTriggered(endpoint)) {
      if (endpoint.platform === "gcfv1") {
        await this.deleteScheduleV1(endpoint);
        return;
      } else if (endpoint.platform === "gcfv2") {
        await this.deleteScheduleV2(endpoint);
        return;
      }
      assertExhaustive(endpoint.platform);
    } else if (backend.isTaskQueueTriggered(endpoint)) {
      await this.disableTaskQueue(endpoint);
    } else if (backend.isBlockingTriggered(endpoint)) {
      await this.unregisterBlockingTrigger(endpoint);
    }
  }

  async upsertScheduleV1(endpoint: backend.Endpoint & backend.ScheduleTriggered): Promise<void> {
    // The Pub/Sub topic is already created
    const job = scheduler.jobFromEndpoint(endpoint, this.appEngineLocation);
    await this.executor
      .run(() => scheduler.createOrReplaceJob(job))
      .catch(rethrowAs(endpoint, "upsert schedule"));
  }

  upsertScheduleV2(endpoint: backend.Endpoint & backend.ScheduleTriggered): Promise<void> {
    return Promise.reject(
      new reporter.DeploymentError(endpoint, "upsert schedule", new Error("Not implemented"))
    );
  }

  async upsertTaskQueue(endpoint: backend.Endpoint & backend.TaskQueueTriggered): Promise<void> {
    const queue = cloudtasks.queueFromEndpoint(endpoint);
    await this.executor
      .run(() => cloudtasks.upsertQueue(queue))
      .catch(rethrowAs(endpoint, "upsert task queue"));

    // Note: should we split setTrigger into createTrigger and updateTrigger so we can avoid a
    // getIamPolicy on create?
    if (endpoint.taskQueueTrigger.invoker) {
      await this.executor
        .run(() => cloudtasks.setEnqueuer(queue.name, endpoint.taskQueueTrigger.invoker!))
        .catch(rethrowAs(endpoint, "set invoker"));
    }
  }

  async registerBlockingTrigger(
    endpoint: backend.Endpoint & backend.BlockingTriggered,
    update: boolean
  ): Promise<void> {
    this.triggerQueue = this.triggerQueue.then(async () => {
      await this.executor
        .run(() => services.serviceForEndpoint(endpoint).registerTrigger(endpoint, update))
        .catch(rethrowAs(endpoint, "register blocking trigger"));
    });
    return this.triggerQueue;
  }

  async deleteScheduleV1(endpoint: backend.Endpoint & backend.ScheduleTriggered): Promise<void> {
    const job = scheduler.jobFromEndpoint(endpoint, this.appEngineLocation);
    await this.executor
      .run(() => scheduler.deleteJob(job.name))
      .catch(rethrowAs(endpoint, "delete schedule"));

    await this.executor
      .run(() => pubsub.deleteTopic(job.pubsubTarget!.topicName))
      .catch(rethrowAs(endpoint, "delete topic"));
  }

  deleteScheduleV2(endpoint: backend.Endpoint & backend.ScheduleTriggered): Promise<void> {
    return Promise.reject(
      new reporter.DeploymentError(endpoint, "delete schedule", new Error("Not implemented"))
    );
  }

  async disableTaskQueue(endpoint: backend.Endpoint & backend.TaskQueueTriggered): Promise<void> {
    const update = {
      name: cloudtasks.queueNameForEndpoint(endpoint),
      state: "DISABLED" as cloudtasks.State,
    };
    await this.executor
      .run(() => cloudtasks.updateQueue(update))
      .catch(rethrowAs(endpoint, "disable task queue"));
  }

  async unregisterBlockingTrigger(
    endpoint: backend.Endpoint & backend.BlockingTriggered
  ): Promise<void> {
    this.triggerQueue = this.triggerQueue.then(async () => {
      await this.executor
        .run(() => services.serviceForEndpoint(endpoint).unregisterTrigger(endpoint))
        .catch(rethrowAs(endpoint, "unregister blocking trigger"));
    });
    return this.triggerQueue;
  }

  logOpStart(op: string, endpoint: backend.Endpoint): void {
    const runtime = getHumanFriendlyRuntimeName(endpoint.runtime);
    const label = helper.getFunctionLabel(endpoint);
    utils.logBullet(
      `${clc.bold.cyan("functions:")} ${op} ${runtime} function ${clc.bold(label)}...`
    );
  }

  logOpSuccess(op: string, endpoint: backend.Endpoint): void {
    const label = helper.getFunctionLabel(endpoint);
    utils.logSuccess(`${clc.bold.green(`functions[${label}]`)} Successful ${op} operation.`);
  }
}
