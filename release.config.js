export default {
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "angular" }],
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    "@semantic-release/github",
    ["@semantic-release/git", { assets: ["CHANGELOG.md", "package.json", "package-lock.json"] }],
  ],
};
