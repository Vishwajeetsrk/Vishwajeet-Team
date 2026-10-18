export interface DependencyNode {
  id: string;
  dependencies: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDependencies(
  nodes: DependencyNode[],
  existingTaskIds: Set<string>
): ValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeIds.has(dep) && !existingTaskIds.has(dep)) {
        errors.push(`Task ${node.id} depends on unknown task ${dep}`);
      }
      if (dep === node.id) {
        errors.push(`Task ${node.id} depends on itself`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function detectCycle(nodes: DependencyNode[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    graph.set(node.id, node.dependencies);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): string[] | null {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const deps = graph.get(nodeId) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      } else if (recursionStack.has(dep)) {
        const cycleStart = path.indexOf(dep);
        return path.slice(cycleStart);
      }
    }

    recursionStack.delete(nodeId);
    path.pop();
    return null;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const cycle = dfs(node.id);
      if (cycle) return cycle;
    }
  }

  return null;
}

export function getReadyTasks(
  nodes: DependencyNode[],
  completedIds: ReadonlySet<string>
): string[] {
  return nodes
    .filter((node) => {
      if (completedIds.has(node.id)) return false;
      return node.dependencies.every((dep) => completedIds.has(dep));
    })
    .map((n) => n.id);
}

export function getBlockedTasks(
  nodes: DependencyNode[],
  completedIds: ReadonlySet<string>
): string[] {
  const ready = new Set(getReadyTasks(nodes, completedIds));
  return nodes
    .filter((node) => !completedIds.has(node.id) && !ready.has(node.id))
    .map((n) => n.id);
}

export function topologicalSort(nodes: DependencyNode[]): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const temp = new Set<string>();

  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    graph.set(node.id, node.dependencies);
  }

  function visit(id: string): void {
    if (temp.has(id)) return;
    if (visited.has(id)) return;
    temp.add(id);
    for (const dep of graph.get(id) ?? []) {
      visit(dep);
    }
    temp.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const node of nodes) {
    visit(node.id);
  }

  return sorted;
}
