import type { ArchGroup, CodeNode, DeclaredType, StructurePlan } from '../types';

interface LayerRule {
  id: string;
  label: string;
  description: string;
  test: (name: string, node: CodeNode) => boolean;
}

const stripInterfacePrefix = (name: string): string =>
  name.length > 1 && name[0] === 'I' && name[1] === name[1].toUpperCase() ? name.slice(1) : name;

// Heuristic but transparent: layers are inferred from widely used naming
// conventions and the folder a type lives in. Types that match nothing land in
// "Application" rather than being forced into an invented category.
//
// Layers are always computed *inside one app*. A monorepo's frontend and
// backend never share a bucket, so "Models" always means one project's models.
const RULES: LayerRule[] = [
  {
    id: 'layer:api',
    label: 'API / Controllers',
    description: 'HTTP surface — controllers, views and endpoints.',
    test: (n) => /Controller$|ApiController$|Endpoint$|ViewSet$|View$|Resource$/.test(n),
  },
  {
    id: 'layer:services',
    label: 'Services',
    description: 'Business logic and orchestration.',
    test: (n) => /Service$|Manager$|Provider$|Processor$|Factory$|Orchestrator$|Coordinator$|UseCase$|Handler$|Task$/.test(n),
  },
  {
    id: 'layer:data',
    label: 'Data Access',
    description: 'Repositories, gateways and persistence.',
    test: (n) => /Repository$|Repo$|Dao$|Store$|Gateway$|UnitOfWork$|DbContext$|Context$|Session$|Migration$/.test(n),
  },
  {
    id: 'layer:middleware',
    label: 'Middleware',
    description: 'Cross-cutting request pipeline components.',
    test: (n) => /Middleware$|Filter$|Interceptor$|Behavior$|Pipeline$|Decorator$|Permission$/.test(n),
  },
  {
    id: 'layer:models',
    label: 'Models & DTOs',
    description: 'Entities, value objects and transfer objects.',
    test: (n, node) =>
      node.kind === 'enum' ||
      node.kind === 'struct' ||
      /Model$|Entity$|Dto$|DTO$|Request$|Response$|ViewModel$|Command$|Query$|Event$|Message$|Result$|Record$|Payload$|Schema$|Type$|Props$|State$/.test(n) ||
      // Django/ORM model classes are not always suffixed.
      /^(Base)?Model$|^Meta$/.test(n),
  },
  {
    id: 'layer:abstractions',
    label: 'Abstractions',
    description: 'Interfaces and contracts.',
    test: (_n, node) => node.kind === 'interface',
  },
  {
    id: 'layer:infrastructure',
    label: 'Infrastructure',
    description: 'Bootstrap, extensions and platform glue.',
    test: (n) => /Startup$|Program$|Bootstrap$|Extensions$|Installer$|Host$|Builder$|Module$|Settings$|Configuration$|Config$|Urls$|Wsgi$|Asgi$/.test(n),
  },
  {
    id: 'layer:utilities',
    label: 'Utilities',
    description: 'Helpers and shared primitives.',
    test: (n) => /Helper$|Helpers$|Util$|Utils$|Extensions$|Mapper$|Converter$|Serializer$|Validator$|Formatting$|Parser$/.test(n),
  },
];

const FOLDER_HINTS: Array<{ pattern: RegExp; groupId: string }> = [
  { pattern: /(^|\/)(controllers?|api|endpoints?|views?|routes?)([./]|$)/i, groupId: 'layer:api' },
  { pattern: /(^|\/)(services?|domain|business|logic|use-?cases?|handlers?)([./]|$)/i, groupId: 'layer:services' },
  { pattern: /(^|\/)(repositor(y|ies)|data|persistence|dal|dao|store|migrations?|entities)([./]|$)/i, groupId: 'layer:data' },
  { pattern: /(^|\/)(middleware|filters?|interceptors?|pipeline|permissions?)([./]|$)/i, groupId: 'layer:middleware' },
  { pattern: /(^|\/)(models?|dtos?|viewmodels?|contracts|schemas?|types?)([./]|$)/i, groupId: 'layer:models' },
  { pattern: /(^|\/)(interfaces?|abstractions)([./]|$)/i, groupId: 'layer:abstractions' },
  { pattern: /(^|\/)(util(s|ities)?|helpers?|common|shared|lib)([./]|$)/i, groupId: 'layer:utilities' },
  { pattern: /(^|\/)(infrastructure|infra|platform|hosting|bootstrap|config|settings)([./]|$)/i, groupId: 'layer:infrastructure' },
];

const FALLBACK_LABEL = 'Application';
const FALLBACK_ID = 'layer:application';

const LAYER_ORDER = [...RULES.map((rule) => rule.id), FALLBACK_ID];

/**
 * Folder names that describe a *layer*, not a project. A repository laid out as
 * `Controllers/`, `Services/`, `Models/` is one application with layers —
 * treating each folder as its own project would be a lie, so the scanner uses
 * this to tell a layer folder from a real unit of the codebase.
 */
const LAYER_FOLDER_NAME = /^(controllers?|api|endpoints?|views?|routes?|services?|domain|business|logic|use-?cases?|handlers?|repositor(y|ies)|data|persistence|dal|dao|store|migrations?|entities|middleware|filters?|interceptors?|pipeline|permissions?|models?|dtos?|viewmodels?|contracts|schemas?|types?|interfaces?|abstractions|util(s|ities)?|helpers?|common|shared|lib|infrastructure|infra|platform|hosting|bootstrap|config|settings|tests?|__tests__|specs?)$/i;

export function isLayerFolderName(name: string): boolean {
  return LAYER_FOLDER_NAME.test(name);
}

function layerMeta(layerId: string): { label: string; description: string } {
  for (const rule of RULES) {
    if (rule.id === layerId) return { label: rule.label, description: rule.description };
  }
  return { label: FALLBACK_LABEL, description: 'Types that follow no dominant naming convention.' };
}

/**
 * Assigns each type node to an architectural layer within its own scope (app
 * or grouping folder) and returns the groups. `declared` supplies the parser's
 * view of each type so folder-based hints can be applied.
 */
export function buildGroups(
  typeNodes: CodeNode[],
  declared: Map<string, DeclaredType>,
  plan: StructurePlan,
  projectName: string,
): ArchGroup[] {
  const byId = new Map<string, ArchGroup>();
  const scopeOrder = new Map<string, number>();
  scopeOrder.set('', 0);
  plan.scopes.forEach((scope, i) => scopeOrder.set(scope.path, i + 1));

  const displayName = (scopeId: string): string => {
    if (!scopeId) return projectName;
    const scope = plan.scopes.find((entry) => entry.path === scopeId);
    if (scope) return scope.name;
    return scopeId.slice(scopeId.lastIndexOf('/') + 1);
  };

  const touch = (appId: string, layerId: string): ArchGroup => {
    const id = `app:${appId}|${layerId}`;
    let group = byId.get(id);
    if (!group) {
      const meta = layerMeta(layerId);
      group = {
        id,
        label: meta.label,
        description: meta.description,
        source: 'layer',
        memberIds: [],
        appId,
        appLabel: displayName(appId),
      };
      byId.set(id, group);
    }
    return group;
  };

  for (const node of typeNodes) {
    const decl = declared.get(node.id);
    const filePath = decl?.fileId ?? node.filePath;
    const appId = filePath ? plan.scopeOfPath(filePath) : '';
    const folder = filePath && filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const baseName = stripInterfacePrefix(node.name);

    let layerId: string | null = null;

    for (const rule of RULES) {
      if (rule.test(baseName, node)) { layerId = rule.id; break; }
    }

    if (!layerId) {
      for (const hint of FOLDER_HINTS) {
        if (hint.pattern.test(folder) || hint.pattern.test(filePath ?? '')) { layerId = hint.groupId; break; }
      }
    }

    if (layerId === 'layer:abstractions' && node.kind === 'interface' && decl) {
      // An interface named *Service belongs with the services layer.
      for (const rule of RULES) {
        if (rule.id !== 'layer:abstractions' && rule.test(baseName, node)) { layerId = rule.id; break; }
      }
    }

    const group = touch(appId, layerId ?? FALLBACK_ID);
    group.memberIds.push(node.id);
    node.groupId = group.id;
  }

  return Array.from(byId.values())
    .filter((group) => group.memberIds.length > 0)
    .sort((a, b) => {
      const appDelta = (scopeOrder.get(a.appId) ?? 999) - (scopeOrder.get(b.appId) ?? 999);
      if (appDelta !== 0) return appDelta;
      const layerDelta = LAYER_ORDER.indexOf(layerOf(a.id)) - LAYER_ORDER.indexOf(layerOf(b.id));
      if (layerDelta !== 0) return layerDelta;
      return a.label.localeCompare(b.label);
    });
}

function layerOf(groupId: string): string {
  return groupId.includes('|') ? groupId.slice(groupId.lastIndexOf('|') + 1) : groupId;
}
