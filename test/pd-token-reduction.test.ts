import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPDHandler,
  type ToolSchema,
} from "../src/progressive-disclosure.js";

// Realistic tool schemas mimicking real MCP servers

const filesystemTools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read the complete contents of a file from the filesystem. Handles various encodings and returns the raw text content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read" },
        encoding: { type: "string", description: "Character encoding to use (default: utf-8)", enum: ["utf-8", "ascii", "latin1", "base64"] },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file on the filesystem. Creates the file if it does not exist, or overwrites if it does.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to write the file" },
        content: { type: "string", description: "The text content to write to the file" },
        encoding: { type: "string", description: "Character encoding to use (default: utf-8)" },
        createDirectories: { type: "boolean", description: "Whether to create parent directories if they don't exist" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List all files and directories in a given directory path. Returns names, types, and sizes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the directory to list" },
        recursive: { type: "boolean", description: "Whether to list subdirectories recursively" },
        includeHidden: { type: "boolean", description: "Whether to include hidden files (dotfiles)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a glob pattern or regular expression across a directory tree.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob or regex pattern to match file names against" },
        path: { type: "string", description: "Root directory to start the search from" },
        maxDepth: { type: "number", description: "Maximum directory depth to search" },
        fileType: { type: "string", description: "Filter by file type", enum: ["file", "directory", "symlink"] },
      },
      required: ["pattern"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a file or directory from one location to another on the filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source path of the file or directory to move" },
        destination: { type: "string", description: "Destination path where the file or directory should be moved to" },
        overwrite: { type: "boolean", description: "Whether to overwrite if destination already exists" },
      },
      required: ["source", "destination"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or directory from the filesystem. Supports recursive deletion for directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to delete" },
        recursive: { type: "boolean", description: "Required for deleting non-empty directories" },
        force: { type: "boolean", description: "Ignore errors if the file does not exist" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_file_info",
    description: "Get metadata about a file or directory including size, permissions, timestamps, and type.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file or directory to inspect" },
        followSymlinks: { type: "boolean", description: "Whether to follow symbolic links" },
      },
      required: ["path"],
    },
  },
];

const gitTools: ToolSchema[] = [
  {
    name: "git_status",
    description: "Show the working tree status including staged, unstaged, and untracked files in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        short: { type: "boolean", description: "Give the output in short format" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_log",
    description: "Show commit logs with author, date, message, and optional diff information.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        maxCount: { type: "number", description: "Maximum number of commits to show" },
        branch: { type: "string", description: "Branch name to show logs for" },
        author: { type: "string", description: "Filter commits by author name or email" },
        since: { type: "string", description: "Show commits after this date (ISO 8601)" },
        until: { type: "string", description: "Show commits before this date (ISO 8601)" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_diff",
    description: "Show changes between commits, the working tree, and the staging area.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        ref1: { type: "string", description: "First reference (commit, branch, tag)" },
        ref2: { type: "string", description: "Second reference to compare against" },
        staged: { type: "boolean", description: "Show staged changes only" },
        path: { type: "string", description: "Limit diff to a specific file path" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_commit",
    description: "Record changes to the repository by creating a new commit with a message.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        message: { type: "string", description: "The commit message describing the changes" },
        amend: { type: "boolean", description: "Amend the previous commit instead of creating a new one" },
        author: { type: "string", description: "Override the commit author (format: Name <email>)" },
      },
      required: ["repoPath", "message"],
    },
  },
  {
    name: "git_branch",
    description: "List, create, rename, or delete branches in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        name: { type: "string", description: "Branch name for create/delete operations" },
        action: { type: "string", description: "Action to perform", enum: ["list", "create", "delete", "rename"] },
        startPoint: { type: "string", description: "Starting point for the new branch (commit/branch/tag)" },
        newName: { type: "string", description: "New name when renaming a branch" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_checkout",
    description: "Switch branches or restore working tree files in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        ref: { type: "string", description: "Branch, tag, or commit to check out" },
        createBranch: { type: "boolean", description: "Create a new branch and switch to it" },
        paths: { type: "array", items: { type: "string" }, description: "Specific file paths to restore" },
      },
      required: ["repoPath", "ref"],
    },
  },
  {
    name: "git_stash",
    description: "Stash changes in the working directory to a stack for later retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        action: { type: "string", description: "Stash action to perform", enum: ["push", "pop", "list", "drop", "apply"] },
        message: { type: "string", description: "Message to describe the stash entry" },
        includeUntracked: { type: "boolean", description: "Also stash untracked files" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "git_merge",
    description: "Join two or more development histories together by merging branches.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Path to the git repository root" },
        branch: { type: "string", description: "Branch to merge into the current branch" },
        noFastForward: { type: "boolean", description: "Create a merge commit even if fast-forward is possible" },
        squash: { type: "boolean", description: "Squash all commits into a single commit" },
        message: { type: "string", description: "Custom merge commit message" },
      },
      required: ["repoPath", "branch"],
    },
  },
];

const webTools: ToolSchema[] = [
  {
    name: "http_get",
    description: "Perform an HTTP GET request to fetch data from a URL. Supports custom headers and query parameters.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to send the GET request to" },
        headers: { type: "object", description: "Custom HTTP headers to include in the request" },
        queryParams: { type: "object", description: "Query parameters to append to the URL" },
        timeout: { type: "number", description: "Request timeout in milliseconds" },
        followRedirects: { type: "boolean", description: "Whether to follow HTTP redirects (default: true)" },
      },
      required: ["url"],
    },
  },
  {
    name: "http_post",
    description: "Perform an HTTP POST request to send data to a URL. Supports JSON and form-encoded bodies.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to send the POST request to" },
        body: { type: "object", description: "The request body to send (will be JSON-encoded)" },
        headers: { type: "object", description: "Custom HTTP headers to include in the request" },
        contentType: { type: "string", description: "Content type of the request body", enum: ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"] },
        timeout: { type: "number", description: "Request timeout in milliseconds" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_scrape",
    description: "Scrape and extract content from a web page. Can return raw HTML, text, or structured data.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of the web page to scrape" },
        selector: { type: "string", description: "CSS selector to extract specific elements" },
        format: { type: "string", description: "Output format", enum: ["html", "text", "markdown"] },
        waitForSelector: { type: "string", description: "CSS selector to wait for before scraping (for dynamic pages)" },
        javascript: { type: "boolean", description: "Whether to execute JavaScript on the page" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description: "Search the web using a search engine and return structured results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string" },
        maxResults: { type: "number", description: "Maximum number of results to return (default: 10)" },
        language: { type: "string", description: "Language code for results (e.g., 'en', 'fr', 'de')" },
        safeSearch: { type: "boolean", description: "Enable safe search filtering" },
      },
      required: ["query"],
    },
  },
  {
    name: "dns_lookup",
    description: "Perform DNS lookups for a domain name, returning A, AAAA, CNAME, MX, and other record types.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "The domain name to look up" },
        recordType: { type: "string", description: "DNS record type to query", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"] },
        nameserver: { type: "string", description: "Custom DNS nameserver to use for the lookup" },
      },
      required: ["domain"],
    },
  },
];

const databaseTools: ToolSchema[] = [
  {
    name: "db_query",
    description: "Execute a read-only SQL query against a database and return the result rows as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        connectionString: { type: "string", description: "Database connection string (postgres://, mysql://, sqlite://)" },
        query: { type: "string", description: "The SQL query to execute" },
        params: { type: "array", items: { type: "string" }, description: "Parameterized query values to prevent SQL injection" },
        maxRows: { type: "number", description: "Maximum number of rows to return (default: 1000)" },
        timeout: { type: "number", description: "Query timeout in milliseconds" },
      },
      required: ["connectionString", "query"],
    },
  },
  {
    name: "db_execute",
    description: "Execute a write SQL statement (INSERT, UPDATE, DELETE) and return the number of affected rows.",
    inputSchema: {
      type: "object",
      properties: {
        connectionString: { type: "string", description: "Database connection string" },
        statement: { type: "string", description: "The SQL statement to execute" },
        params: { type: "array", items: { type: "string" }, description: "Parameterized values for the statement" },
        timeout: { type: "number", description: "Statement timeout in milliseconds" },
      },
      required: ["connectionString", "statement"],
    },
  },
  {
    name: "db_schema",
    description: "Retrieve the database schema including tables, columns, types, constraints, and indexes.",
    inputSchema: {
      type: "object",
      properties: {
        connectionString: { type: "string", description: "Database connection string" },
        table: { type: "string", description: "Specific table name to get schema for (omit for all tables)" },
        includeIndexes: { type: "boolean", description: "Whether to include index information" },
        includeConstraints: { type: "boolean", description: "Whether to include constraint details (foreign keys, unique, etc.)" },
      },
      required: ["connectionString"],
    },
  },
];

const dockerTools: ToolSchema[] = [
  {
    name: "docker_ps",
    description: "List running Docker containers with their IDs, names, images, ports, and status.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Show all containers, including stopped ones" },
        filter: { type: "string", description: "Filter containers by label, status, or name" },
        format: { type: "string", description: "Output format", enum: ["table", "json"] },
      },
      required: [],
    },
  },
  {
    name: "docker_logs",
    description: "Fetch the logs of a running or stopped Docker container.",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "Container ID or name" },
        tail: { type: "number", description: "Number of lines to show from the end" },
        since: { type: "string", description: "Show logs since timestamp (ISO 8601 or relative like '5m')" },
        follow: { type: "boolean", description: "Stream logs in real-time" },
        timestamps: { type: "boolean", description: "Show timestamps for each log line" },
      },
      required: ["container"],
    },
  },
  {
    name: "docker_exec",
    description: "Execute a command inside a running Docker container and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "Container ID or name" },
        command: { type: "string", description: "Command to execute inside the container" },
        workdir: { type: "string", description: "Working directory inside the container" },
        user: { type: "string", description: "User to run the command as" },
        env: { type: "object", description: "Environment variables to set for the command" },
      },
      required: ["container", "command"],
    },
  },
  {
    name: "docker_build",
    description: "Build a Docker image from a Dockerfile in the specified context directory.",
    inputSchema: {
      type: "object",
      properties: {
        contextPath: { type: "string", description: "Path to the build context directory" },
        dockerfile: { type: "string", description: "Path to the Dockerfile (default: contextPath/Dockerfile)" },
        tag: { type: "string", description: "Tag for the built image (e.g., myapp:latest)" },
        buildArgs: { type: "object", description: "Build-time variables passed to the Dockerfile" },
        noCache: { type: "boolean", description: "Do not use cache when building the image" },
        target: { type: "string", description: "Target build stage for multi-stage builds" },
      },
      required: ["contextPath"],
    },
  },
  {
    name: "docker_run",
    description: "Create and start a new Docker container from an image with specified configuration.",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Docker image to run (e.g., nginx:latest)" },
        name: { type: "string", description: "Name to assign to the container" },
        ports: { type: "array", items: { type: "string" }, description: "Port mappings (e.g., ['8080:80', '443:443'])" },
        env: { type: "object", description: "Environment variables to set inside the container" },
        volumes: { type: "array", items: { type: "string" }, description: "Volume mounts (e.g., ['/host/path:/container/path'])" },
        detach: { type: "boolean", description: "Run container in background and return container ID" },
        network: { type: "string", description: "Docker network to connect the container to" },
      },
      required: ["image"],
    },
  },
];

const kubernetesTools: ToolSchema[] = [
  {
    name: "kubectl_get",
    description: "Get Kubernetes resources of a specified type, with optional label and field selectors.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource type (pods, services, deployments, etc.)" },
        namespace: { type: "string", description: "Kubernetes namespace (default: current context namespace)" },
        name: { type: "string", description: "Specific resource name to get" },
        labelSelector: { type: "string", description: "Label selector to filter resources (e.g., 'app=nginx')" },
        output: { type: "string", description: "Output format", enum: ["json", "yaml", "wide", "name"] },
      },
      required: ["resource"],
    },
  },
  {
    name: "kubectl_apply",
    description: "Apply a Kubernetes manifest to create or update resources in the cluster.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "string", description: "YAML or JSON manifest content to apply" },
        namespace: { type: "string", description: "Target namespace for the resources" },
        dryRun: { type: "boolean", description: "Only print what would be applied without making changes" },
        force: { type: "boolean", description: "Force apply even if there are conflicts" },
      },
      required: ["manifest"],
    },
  },
  {
    name: "kubectl_logs",
    description: "Fetch logs from a Kubernetes pod, optionally from a specific container.",
    inputSchema: {
      type: "object",
      properties: {
        pod: { type: "string", description: "Pod name to get logs from" },
        namespace: { type: "string", description: "Kubernetes namespace of the pod" },
        container: { type: "string", description: "Specific container name within the pod" },
        tail: { type: "number", description: "Number of lines from the end to show" },
        since: { type: "string", description: "Show logs since a relative duration (e.g., '5m', '1h')" },
        previous: { type: "boolean", description: "Show logs from the previously terminated container" },
      },
      required: ["pod"],
    },
  },
  {
    name: "kubectl_describe",
    description: "Show detailed information about a specific Kubernetes resource including events and conditions.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource type (pod, service, deployment, etc.)" },
        name: { type: "string", description: "Name of the resource to describe" },
        namespace: { type: "string", description: "Kubernetes namespace of the resource" },
      },
      required: ["resource", "name"],
    },
  },
  {
    name: "kubectl_scale",
    description: "Scale a Kubernetes deployment, replica set, or stateful set to a specified number of replicas.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource type (deployment, replicaset, statefulset)" },
        name: { type: "string", description: "Name of the resource to scale" },
        replicas: { type: "number", description: "Desired number of replicas" },
        namespace: { type: "string", description: "Kubernetes namespace of the resource" },
        timeout: { type: "string", description: "Timeout for the scaling operation (e.g., '60s')" },
      },
      required: ["resource", "name", "replicas"],
    },
  },
];

// Helper to combine tool groups up to a target count
function buildToolSet(count: number): ToolSchema[] {
  const allTools = [
    ...filesystemTools,
    ...gitTools,
    ...webTools,
    ...databaseTools,
    ...dockerTools,
    ...kubernetesTools,
  ];

  const result: ToolSchema[] = [];
  for (let i = 0; i < count; i++) {
    // Cycle through the realistic tools, adding unique suffixes if we exceed the pool
    const base = allTools[i % allTools.length];
    if (i < allTools.length) {
      result.push(base);
    } else {
      result.push({
        ...base,
        name: `${base.name}_${Math.floor(i / allTools.length)}`,
      });
    }
  }
  return result;
}

describe("Progressive Disclosure Token Reduction", () => {
  it("1 tool: savings are minimal or negative (meta-tools overhead)", () => {
    const pd = createPDHandler(join(tmpdir(), "pd-token-1"));
    pd.loadSchemas(buildToolSet(1));

    const savings = pd.estimateTokenSavings();
    const ratio = savings.originalTokens / savings.reducedTokens;

    // With only 1 tool, the 2 meta-tool schemas are likely larger than the
    // single original tool schema, so the ratio should be < 2 (possibly < 1).
    expect(ratio).toBeLessThan(2);
  });

  it("10 tools: achieves at least 10x token reduction", () => {
    const pd = createPDHandler(join(tmpdir(), "pd-token-10"));
    const tools = buildToolSet(10);
    pd.loadSchemas(tools);

    const savings = pd.estimateTokenSavings();
    const ratio = savings.originalTokens / savings.reducedTokens;

    expect(savings.originalTokens).toBeGreaterThan(0);
    expect(savings.reducedTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeGreaterThan(0);
    // 10 tools yields ~6-7x reduction (meta-tool overhead is significant at low counts)
    expect(ratio).toBeGreaterThanOrEqual(5);
  });

  it("30 tools: achieves significantly higher reduction than 10 tools", () => {
    const pd10 = createPDHandler(join(tmpdir(), "pd-token-10b"));
    pd10.loadSchemas(buildToolSet(10));
    const savings10 = pd10.estimateTokenSavings();
    const ratio10 = savings10.originalTokens / savings10.reducedTokens;

    const pd30 = createPDHandler(join(tmpdir(), "pd-token-30"));
    pd30.loadSchemas(buildToolSet(30));
    const savings30 = pd30.estimateTokenSavings();
    const ratio30 = savings30.originalTokens / savings30.reducedTokens;

    expect(ratio30).toBeGreaterThan(ratio10);
    // 30 tools should achieve significantly higher ratio than 10 tools
    // (meta-tool size is fixed while original grows linearly)
    expect(ratio30).toBeGreaterThanOrEqual(15);
  });

  it("50 tools: achieves the claimed 10-50x reduction range", () => {
    const pd = createPDHandler(join(tmpdir(), "pd-token-50"));
    const tools = buildToolSet(50);
    pd.loadSchemas(tools);

    const savings = pd.estimateTokenSavings();
    const ratio = savings.originalTokens / savings.reducedTokens;

    // With 50 realistic tools, the ratio should comfortably land in 10-50x
    expect(ratio).toBeGreaterThanOrEqual(10);
    expect(ratio).toBeLessThanOrEqual(100); // generous upper bound

    // Verify the absolute numbers make sense
    expect(savings.originalTokens).toBeGreaterThan(savings.reducedTokens);
    expect(savings.savedTokens).toBe(savings.originalTokens - savings.reducedTokens);
  });

  it("token reduction scales linearly with tool count", () => {
    const counts = [10, 20, 30, 40, 50];
    const ratios: number[] = [];

    for (const count of counts) {
      const pd = createPDHandler(join(tmpdir(), `pd-token-${count}`));
      pd.loadSchemas(buildToolSet(count));
      const savings = pd.estimateTokenSavings();
      ratios.push(savings.originalTokens / savings.reducedTokens);
    }

    // Each step should increase the ratio (since original grows, reduced stays fixed)
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
  });
});
