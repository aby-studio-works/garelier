const root = `${import.meta.dir}/..`;
const glob = new Bun.Glob("skills/garelier-*/SKILL.md");
const failures: string[] = [];
let checked = 0;

for await (const relative of glob.scan({ cwd: root, onlyFiles: true })) {
  checked += 1;
  const text = await Bun.file(`${root}/${relative}`).text();
  const end = text.indexOf("\n---\n", 4);

  if (!text.startsWith("---\n") || end < 0) {
    failures.push(`${relative}: missing YAML frontmatter delimiters`);
    continue;
  }

  try {
    const parsed = Bun.YAML.parse(text.slice(4, end)) as Record<string, unknown>;
    const expectedName = relative.replaceAll("\\", "/").split("/").at(-2);

    if (parsed.name !== expectedName) {
      failures.push(`${relative}: name must be ${expectedName}`);
    }
    if (typeof parsed.description !== "string" || !parsed.description.trim()) {
      failures.push(`${relative}: description must be a non-empty YAML string`);
    }
    if ("requires" in parsed && typeof parsed.requires !== "string") {
      failures.push(`${relative}: requires must be a YAML string when present`);
    }
  } catch (error) {
    failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) {
  console.error("skill frontmatter validation failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`skill frontmatter: ok (${checked} checked)`);
