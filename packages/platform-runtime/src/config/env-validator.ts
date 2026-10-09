/**
 * Environment validation for `ConfigModule.forRoot`'s `validate` hook.
 *
 * Both products wrote the same function: run the schema, and on failure throw an
 * `Error` whose message lists every offending key on its own line. The value is in
 * the FAILURE path — a bad deploy should say which four variables are missing, not
 * fail on the first one and hide the rest behind another deploy cycle.
 *
 * STRUCTURALLY TYPED, NOT ZOD-TYPED — deliberately. Taking `ZodSchema` would make
 * this package carry a zod peer dependency and pin every consumer to the same major.
 * The two members used here (`safeParse`, and `error.issues`) are all a validator
 * needs to expose, so the contract is written out below and any library satisfying it
 * works. `zod@4`'s `safeParse` matches it exactly.
 */

/** The shape of a validation failure this module can format. */
export interface EnvValidationIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/** The subset of a schema's surface required to validate an environment. */
export interface EnvSchemaLike<TEnv> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: TEnv }
    | { success: false; error: { issues: ReadonlyArray<EnvValidationIssue> } };
}

/**
 * Build the `validate` function `ConfigModule.forRoot` expects.
 *
 * Returns the PARSED value, not the raw input: a schema that coerces (`z.coerce.number()`
 * on a port, a defaulted flag) is doing work that must reach `ConfigService`, and
 * returning the input silently discards it while still reporting success.
 */
export function createEnvValidator<TEnv>(
  schema: EnvSchemaLike<TEnv>,
): (env: Record<string, unknown>) => TEnv {
  return (env) => {
    const result = schema.safeParse(env);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `  ${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`❌ Invalid environment configuration:\n${detail}`);
    }
    return result.data;
  };
}
