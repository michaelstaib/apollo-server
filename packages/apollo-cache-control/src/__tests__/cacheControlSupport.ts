import { buildSchema, GraphQLSchema } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import { plugin, CacheControlExtensionOptions, CacheHint } from '../';
import {
  GraphQLRequestContext,
  GraphQLRequestContextExecutionDidStart,
  GraphQLRequestContextWillSendResponse,
  GraphQLRequest,
  GraphQLResponse,
  ValueOrPromise,
  ApolloServerPlugin,
  WithRequired,
} from 'apollo-server-plugin-base';
import { InMemoryLRUCache } from "apollo-server-caching";
import {
  enablePluginsForSchemaResolvers,
  symbolRequestListenerDispatcher,
} from "apollo-server-core/dist/requestPipelineAPI";

import { Dispatcher } from "apollo-server-core/dist/utils/dispatcher";

type FirstArg<F> = F extends (arg: infer A) => any ? A : never;

export function augmentTypeDefsWithCacheControlSupport(typeDefs: string) {
  return (
    `
  enum CacheControlScope {
    PUBLIC
    PRIVATE
  }

  directive @cacheControl(
    maxAge: Int
    scope: CacheControlScope
  ) on FIELD_DEFINITION | OBJECT | INTERFACE
` + typeDefs
  );
}

export function buildSchemaWithCacheControlSupport(source: string) {
  return buildSchema(augmentTypeDefsWithCacheControlSupport(source));
}

export function makeExecutableSchemaWithCacheControlSupport(
  options: FirstArg<typeof makeExecutableSchema> & { typeDefs: string },
) {
  return makeExecutableSchema({
    ...options,
    typeDefs: augmentTypeDefsWithCacheControlSupport(options.typeDefs),
  });
}

// This test harness guarantees the presence of `query`.
type IPluginTestHarnessGraphqlRequest = WithRequired<GraphQLRequest, 'query'>;
type IPluginTestHarnessExecutionDidStart<TContext> =
  GraphQLRequestContextExecutionDidStart<TContext> & {
    request: IPluginTestHarnessGraphqlRequest,
  };

export async function pluginTestHarness<TContext>({
  schema,
  pluginInitializationOptions = Object.create(null),
  graphqlRequest,
  overallCachePolicy,
  executor,
  context = Object.create(null)
}: {
  /**
   * The schema, which will be mutated, to be received by the executor.
   */
  schema?: GraphQLSchema;

  /**
  * Passed directly to the plugin options.
  */
  pluginInitializationOptions?: CacheControlExtensionOptions;

  /**
   * The `GraphQLRequest` which will be received by the `executor`.  The
   * `query` is required, and this doesn't support anything more exotic,
   * like automated persisted queries (APQ).
   */
  graphqlRequest: IPluginTestHarnessGraphqlRequest;

  /**
   * Overall cache control policy.
   */
  overallCachePolicy?: Required<CacheHint>;

  /**
   * This method will be executed to retrieve the response.
   */
  executor: (
    requestContext: IPluginTestHarnessExecutionDidStart<TContext>,
  ) => ValueOrPromise<GraphQLResponse>;

  /**
   * (optional) To provide a user context, if necessary.
   */
  context?: TContext;
}): Promise<GraphQLRequestContextWillSendResponse<TContext>> {

  if (schema) {
    enablePluginsForSchemaResolvers(schema);
  }

  const pluginInstance: ApolloServerPlugin<TContext> = plugin({
    ...pluginInitializationOptions,
  });

  const requestContext: GraphQLRequestContext<TContext> = {
    logger: console,
    request: graphqlRequest,
    metrics: Object.create(null),
    source: graphqlRequest.query,
    cache: new InMemoryLRUCache(),
    context,
  };

  requestContext.overallCachePolicy = overallCachePolicy;

  if (typeof pluginInstance.requestDidStart !== "function") {
    throw new Error("Should be impossible as the plugin is defined.");
  }

  const listener = pluginInstance.requestDidStart(requestContext);

  if (!listener) {
    throw new Error("Should be impossible to not have a listener.");
  }

  if (typeof listener.willResolveField !== 'function') {
    throw new Error("Should be impossible to not have 'willResolveField'.");
  }

  const dispatcher = new Dispatcher([listener]);

  // Put the dispatcher on the context so `willResolveField` can access it.
  Object.defineProperty(requestContext.context, symbolRequestListenerDispatcher, {
    value: dispatcher,
  });

  const executionDidEnd = dispatcher.invokeDidStartHook(
    "executionDidStart",
    requestContext as IPluginTestHarnessExecutionDidStart<TContext>,
  );

  try {
    // `response` is readonly, so we'll cast to `any` to assign to it.
    (requestContext.response as any) = await executor(
      requestContext as IPluginTestHarnessExecutionDidStart<TContext>,
    );
    executionDidEnd();
  } catch (executionError) {
    executionDidEnd(executionError);
  }

  await dispatcher.invokeHookAsync(
    "willSendResponse",
    requestContext as GraphQLRequestContextWillSendResponse<TContext>,
  );

  return requestContext as GraphQLRequestContextWillSendResponse<TContext>;
}
