/**
 * Client-facing model registry: alias resolution and the image-model
 * sets the route gates consult (S1 section 3.2 / 6.2).
 *
 * The registry is derived once from the normalized config: every
 * provider model contributes one client-facing alias, in family + config
 * order. Resolution is first-match over that sequence; per-family
 * credential rotation inside a direction stays with the facade.
 *
 * The registry deliberately keeps proxy-credentialed entries: the S1
 * model lists are unchanged by the F1 degradation, and model resolution
 * precedes the 501 (S7 section 2.3-F1-4) - an unknown model still gets
 * `model_not_found`, never the proxy body.
 */
import type { ProviderEntry, ProviderFamily, ProviderModelEntry } from './config'

/**
 * Fixed image-only model ids (recorded upstream list). Any of these on
 * a non-images route is the 503 `only supported on /v1/images/*` case;
 * on the images routes they are the built-in supported set.
 */
export const IMAGE_ONLY_MODELS: readonly string[] = [
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5',
  'grok-imagine-image',
  'grok-imagine-image-quality',
  'grok-imagine-image-2.0',
]

/** One client-facing model of the registry. */
export interface RegistryModel {
  /** Client-facing id (alias). */
  readonly id: string
  /** Upstream model id. */
  readonly upstream: string
  /** `owned_by` / provider name of the /v1 model lists. */
  readonly ownedBy: string
  readonly family: ProviderFamily
  /** `display-name` config value (list-only, gemini surface). */
  readonly displayName?: string
  /** openai-compatibility image-capable model flag. */
  readonly image: boolean
}

/** Where a resolved alias points. */
export interface ResolvedModel {
  readonly family: ProviderFamily
  readonly provider: ProviderEntry
  readonly model: ProviderModelEntry
  /** Index of the provider entry within its family (trace + ordering). */
  readonly familyIndex: number
}

/** Immutable view over the configured models, in registration order. */
export class ModelRegistry {
  private readonly models: readonly RegistryModel[]
  private readonly byId: ReadonlyMap<string, ResolvedModel>

  constructor(providers: readonly ProviderEntry[]) {
    const models: RegistryModel[] = []
    const byId = new Map<string, ResolvedModel>()
    const familyCounters = new Map<ProviderFamily, number>()
    for (const provider of providers) {
      const familyIndex = familyCounters.get(provider.family) ?? 0
      familyCounters.set(provider.family, familyIndex + 1)
      for (const model of provider.models) {
        const id = model.alias
        models.push({
          id,
          upstream: model.name,
          ownedBy: provider.providerName,
          family: provider.family,
          ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
          image: model.image,
        })
        if (!byId.has(id)) {
          byId.set(id, { family: provider.family, provider, model, familyIndex })
        }
      }
    }
    this.models = models
    this.byId = byId
  }

  /** Every registered model, registration order (models-list order). */
  list(): readonly RegistryModel[] {
    return this.models
  }

  /** Resolves one client-facing alias; first registration wins. */
  resolve(id: string): ResolvedModel | undefined {
    return this.byId.get(id)
  }

  /** True when the id is an image-only or configured image model. */
  isImageModel(id: string): boolean {
    if (IMAGE_ONLY_MODELS.includes(id)) return true
    const resolved = this.byId.get(id)
    return resolved !== undefined && resolved.model.image
  }
}
