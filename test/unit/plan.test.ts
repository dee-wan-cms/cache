import { describe, expect, it } from "vitest";

import type { GeneratedCacheConfig } from "../../src/core/types";

import { CONFIG_FORMAT } from "../../src/core/limits";
import { planFences, planWrite } from "../../src/core/plan";
import { readTargets } from "../../src/core/targets";

const config: GeneratedCacheConfig = {
  cacheVersion: "test",
  cacheableByModel: { Comment: true, Post: true, User: true },
  configFormat: CONFIG_FORMAT,
  hasDecimalFields: false,
  primaryKeyNameByModel: {},
  modelNames: ["User", "Post", "Comment"],
  primaryKeyFieldsByModel: { Comment: ["postId", "index"], Post: ["id"], User: ["id"] },
  relationGraph: {
    Comment: [{ fieldName: "post", foreignFields: ["id"], localFields: ["postId"], isList: false, oneToOne: false, targetModel: "Post" }],
    Post: [
      { fieldName: "author", foreignFields: ["id"], localFields: ["authorId"], isList: false, oneToOne: false, targetModel: "User" },
      { fieldName: "comments", foreignFields: [], localFields: [], isList: true, oneToOne: false, targetModel: "Comment" },
    ],
    User: [{ fieldName: "posts", foreignFields: [], localFields: [], isList: true, oneToOne: false, targetModel: "Post" }],
  },
};

const fences = (model: string, operation: string, args: unknown) => planFences(planWrite(config, model, operation, args)).sort();

describe("write planning", () => {
  it("fences one entity for a write addressed by primary key", () => {
    expect(fences("Post", "update", { data: { title: "x" }, where: { id: 3 } })).toEqual(["e:Post:3", "w:Post"]);
  });

  it("widens to the model when the write is not addressed by primary key", () => {
    expect(fences("User", "update", { data: { name: "x" }, where: { email: "a@b" } })).toEqual(["m:User", "w:User"]);
  });

  it("only moves the write fence on create", () => {
    expect(fences("User", "create", { data: { id: 9, name: "x" } })).toEqual(["w:User"]);
  });

  it("widens every model that can cascade from a delete, transitively", () => {
    expect(fences("User", "delete", { where: { id: 1 } })).toEqual(["e:User:1", "m:Comment", "m:Post", "w:Comment", "w:Post", "w:User"]);
  });

  it("widens referencing models when a referenced key changes", () => {
    expect(fences("User", "update", { data: { id: 2 }, where: { id: 1 } })).toContain("m:Post");
    expect(fences("User", "update", { data: { name: "x" }, where: { id: 1 } })).not.toContain("m:Post");
  });

  it("follows nested writes and compound keys", () => {
    const planned = fences("User", "update", {
      data: { posts: { connect: { id: 4 }, update: { data: { comments: { delete: { postId_index: { index: 2, postId: 4 } } } }, where: { id: 4 } } } },
      where: { id: 1 },
    });
    expect(planned).toEqual(expect.arrayContaining(["e:Post:4", "e:Comment:4:2", "w:Comment", "w:Post", "e:User:1"]));
  });

  it("widens to the model when a write names more than 100 entities of it", () => {
    const connect = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
    const planned = fences("User", "update", { data: { posts: { connect } }, where: { id: 1 } });
    expect(planned).toContain("m:Post");
    expect(fences("User", "update", { data: { posts: { connect: connect.slice(0, 100) } }, where: { id: 1 } })).not.toContain("m:Post");
  });

  it("falls back to the global fence past the nesting limit", () => {
    let data: Record<string, unknown> = { title: "leaf" };
    for (let i = 0; i < 6; i++) data = { comments: { create: { post: { create: data } } } };
    expect(fences("Post", "create", { data })).toEqual(["g"]);
  });
});

describe("nested write branches", () => {
  const post = (data: Record<string, unknown>) => fences("Post", "update", { data, where: { id: 9 } });
  const user = (data: Record<string, unknown>) => fences("User", "update", { data, where: { id: 1 } });

  it("connectOrCreate addresses the entity by key and follows the nested create", () => {
    expect(user({ posts: { connectOrCreate: { create: { comments: { create: { index: 1 } }, title: "t" }, where: { id: 4 } } } })).toEqual(
      expect.arrayContaining(["e:Post:4", "w:Comment"]),
    );
    expect(user({ posts: { connectOrCreate: { create: { title: "t" }, where: { slug: "x" } } } })).toContain("m:Post");
  });

  it("disconnect and delete widen without a key and address the entity with one", () => {
    expect(post({ author: { disconnect: true } })).toContain("m:User");
    expect(user({ posts: { disconnect: [{ id: 4 }] } })).toEqual(expect.arrayContaining(["e:Post:4"]));
    expect(post({ author: { delete: true } })).toEqual(expect.arrayContaining(["m:User", "m:Post"]));
    expect(user({ posts: { delete: { id: 4 } } })).toEqual(expect.arrayContaining(["e:Post:4", "m:Comment"]));
  });

  it("set, deleteMany and unknown operations widen", () => {
    expect(user({ posts: { set: [{ id: 4 }] } })).toContain("m:Post");
    expect(user({ posts: { deleteMany: { title: "x" } } })).toEqual(expect.arrayContaining(["m:Post", "m:Comment"]));
    expect(user({ posts: { somethingNew: {} } })).toContain("m:Post");
  });

  it("to-one update without where widens, nested upsert with a key addresses the entity", () => {
    expect(post({ author: { update: { name: "x" } } })).toContain("m:User");
    expect(user({ posts: { upsert: { create: { title: "n" }, update: { title: "u" }, where: { id: 4 } } } })).toEqual(
      expect.arrayContaining(["e:Post:4", "w:Post"]),
    );
  });

  it("nested createMany only moves the write fence", () => {
    const planned = user({ posts: { createMany: { data: [{ title: "a" }] } } });
    expect(planned).toContain("w:Post");
    expect(planned).not.toContain("m:Post");
  });

  it("root upsert, updateMany and createMany", () => {
    expect(fences("User", "upsert", { create: {}, update: { name: "x" }, where: { email: "a@b" } })).toContain("m:User");
    expect(fences("User", "updateMany", { data: { name: "x" } })).toEqual(["m:User", "w:User"]);
    expect(fences("User", "createMany", { data: [{ id: 3 }] })).toEqual(["w:User"]);
  });
});

describe("review fixes in write planning", () => {
  const extended: GeneratedCacheConfig = {
    ...config,
    modelNames: [...config.modelNames, "Profile", "Note", "Edition"],
    primaryKeyFieldsByModel: { ...config.primaryKeyFieldsByModel, Edition: ["isbn", "number"], Note: ["id"], Profile: ["id"] },
    primaryKeyNameByModel: { Edition: "editionKey" },
    relationGraph: {
      ...config.relationGraph,
      Note: [{ fieldName: "post", foreignFields: ["slug"], isList: false, localFields: ["postSlug"], oneToOne: false, targetModel: "Post" }],
      Profile: [{ fieldName: "user", foreignFields: ["id"], isList: false, localFields: ["userId"], oneToOne: true, targetModel: "User" }],
      User: [
        { fieldName: "posts", foreignFields: [], isList: true, localFields: [], oneToOne: false, targetModel: "Post" },
        { fieldName: "profile", foreignFields: [], isList: false, localFields: [], oneToOne: true, targetModel: "Profile" },
      ],
    },
  };
  const planned = (model: string, operation: string, args: unknown) => planFences(planWrite(extended, model, operation, args)).sort();

  it("widens models referencing a key changed by a nested updateMany", () => {
    expect(planned("User", "update", { data: { posts: { updateMany: { data: { slug: "new" }, where: {} } } }, where: { id: 1 } })).toContain("m:Note");
    expect(planned("User", "update", { data: { posts: { updateMany: { data: { title: "t" }, where: {} } } }, where: { id: 1 } })).not.toContain("m:Note");
  });

  it("widens both sides when a one-to-one relation is re-pointed", () => {
    expect(planned("User", "update", { data: { profile: { connect: { id: 5 } } }, where: { id: 1 } })).toEqual(
      expect.arrayContaining(["m:Profile", "m:User"]),
    );
    expect(planned("Post", "create", { data: { author: { connect: { id: 1 } }, title: "t" } })).not.toContain("m:User");
  });

  it("widens referencing models when a nested operation changes a referenced foreign key", () => {
    const chain: GeneratedCacheConfig = {
      ...extended,
      modelNames: ["A", "B", "C"],
      primaryKeyFieldsByModel: { A: ["id"], B: ["x"], C: ["id"] },
      relationGraph: {
        A: [{ fieldName: "b", foreignFields: ["x"], isList: false, localFields: ["code"], oneToOne: false, relationName: "AB", targetModel: "B" }],
        B: [{ fieldName: "as", foreignFields: [], isList: true, localFields: [], oneToOne: false, relationName: "AB", targetModel: "A" }],
        C: [{ fieldName: "a", foreignFields: ["code"], isList: false, localFields: ["aCode"], oneToOne: false, relationName: "CA", targetModel: "A" }],
      },
    };
    const chainFences = (model: string, args: unknown) => planFences(planWrite(chain, model, "update", args)).sort();
    expect(chainFences("A", { data: { b: { connect: { x: "new" } } }, where: { id: 1 } })).toContain("m:C");
    expect(chainFences("B", { data: { as: { connect: { id: 1 } } }, where: { x: "k" } })).toContain("m:C");
  });

  it("recognises named compound keys", () => {
    expect(planned("Edition", "update", { data: {}, where: { editionKey: { isbn: "x", number: 2 } } })).toEqual(["e:Edition:x:2", "w:Edition"]);
  });
});

describe("read targets", () => {
  it("collects models reached through include, select, _count and relation filters", () => {
    const targets = readTargets(config.relationGraph, "User", {
      select: { _count: { select: { posts: { where: { comments: { some: { index: 1 } } } } } } },
      where: { posts: { some: { author: { is: { id: 1 } } } } },
    });
    expect([...(targets?.models ?? [])].sort()).toEqual(["Comment", "Post", "User"]);
  });

  const targets = (model: string, args: unknown) => [...(readTargets(config.relationGraph, model, args)?.models ?? [])].sort();

  it("follows relation filters inside AND, OR and NOT", () => {
    expect(targets("User", { where: { OR: [{ name: "x" }, { posts: { some: { title: "t" } } }] } })).toEqual(["Post", "User"]);
    expect(targets("User", { where: { AND: { posts: { none: {} } } } })).toEqual(["Post", "User"]);
    expect(targets("User", { where: { NOT: [{ posts: { every: { title: "t" } } }] } })).toEqual(["Post", "User"]);
  });

  it("follows relation filters through every, none, is and isNot to deeper relations", () => {
    expect(targets("User", { where: { posts: { every: { comments: { some: { index: 1 } } } } } })).toEqual(["Comment", "Post", "User"]);
    expect(targets("Comment", { where: { post: { isNot: { author: { is: { name: "x" } } } } } })).toEqual(["Comment", "Post", "User"]);
  });

  it("marks reads that walk a relation, including self-relations and cursors", () => {
    const selfGraph = { User: [{ fieldName: "manager", foreignFields: ["id"], localFields: ["managerId"], isList: false, oneToOne: false, targetModel: "User" }] };
    expect(readTargets(selfGraph, "User", { include: { manager: true }, where: { id: 1 } })).toEqual({ models: new Set(["User"]), relational: true });
    expect(readTargets(selfGraph, "User", { where: { id: 1 } })).toEqual({ models: new Set(["User"]), relational: false });
    expect(targets("Post", { cursor: { author: { is: { name: "x" } }, id: 1 } })).toEqual(["Post", "User"]);
  });

  it("follows relation ordering and nested projections", () => {
    expect(targets("Post", { orderBy: [{ author: { name: "asc" } }] })).toEqual(["Post", "User"]);
    expect(targets("User", { orderBy: { posts: { _count: "desc" } } })).toEqual(["Post", "User"]);
    expect(targets("User", { select: { posts: { select: { comments: true } } } })).toEqual(["Comment", "Post", "User"]);
    expect(targets("Post", { include: { _count: true } })).toEqual(["Comment", "Post", "User"]);
  });

  it("refuses to cache when relation nesting exceeds the traversal limit", () => {
    let include: Record<string, unknown> = { posts: true };
    for (let i = 0; i < 12; i++) include = { posts: { include: { author: { include } } } };
    expect(readTargets(config.relationGraph, "User", { include })).toBeNull();
  });
});
