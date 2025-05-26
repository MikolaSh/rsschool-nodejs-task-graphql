import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, GraphQLEnumType, GraphQLFloat, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, validate } from 'graphql';
import { MemberType, Post } from '@prisma/client';
import { MemberTypeId } from '../member-types/schemas.js';
import DataLoader from 'dataloader';
import { UUIDType } from './types/uuid.js';

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const { prisma } = fastify;

  const createLoader = <
    T extends { id?: string; memberTypeId?: MemberTypeId },
    K extends string | MemberTypeId
  >(
    batchFn: (keys: readonly K[]) => Promise<T[]>
  ) => {
    return new DataLoader<K, T>(async (keys) => {
      const results = await batchFn(keys);
      return keys.map((key) => {
        const result = results.find((result) => {
          if (result.id !== undefined && typeof key === 'string') {
            return result.id === key;
          }
          if (result.memberTypeId !== undefined && typeof key !== 'string') {
            return result.memberTypeId === key;
          }
          return false;
        }); 

        if (!result) {
          return new Error(`No result for ${key}`);
        }
        return result;
      });
    });
  };

  const MemberTypeIdGQL = new GraphQLEnumType({
    name: "MemberTypeId",
    values: {
      BASIC: {value: "BASIC"},
      BUSINESS: {value: "BUSINESS"}
    },
  });

  const MemberTypeGQL = new GraphQLObjectType({
    name: "MemberType",
    fields: () => ({
      id: { type: MemberTypeIdGQL },
      discount: { type: new GraphQLNonNull(GraphQLFloat) },
      postsLimitPerMonth: { type: new GraphQLNonNull(GraphQLInt) }
    })
  });


  const memberTypeLoader = createLoader<MemberType, MemberTypeId>(async (ids) => {
    const result = await prisma.memberType.findMany({
      where: { id: { in: [...ids] } },
    });
    return result;
  });

  const postLoader = createLoader<Post, string>(async (ids) => {
    return prisma.post.findMany({
      where: { id: { in: [...ids] } },
    });
  });

  const PostGQL = new GraphQLObjectType({
    name: 'Post',
    fields: () => ({
      id: { type: new GraphQLNonNull(UUIDType) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      content: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });


  const RootQueryType = new GraphQLObjectType({
    name: 'RootQuery',
    fields: {
      memberTypes: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberTypeGQL))),
        resolve: () => prisma.memberType.findMany(),
      },
      memberType: {
        type: MemberTypeGQL,
        args: { id: { type: new GraphQLNonNull(MemberTypeIdGQL) } },
        resolve: (_: unknown, args: { id: MemberTypeId }) => memberTypeLoader.load(args.id),
      },
      posts: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PostGQL))),
        resolve: () => prisma.post.findMany(),
      },
      post: {
        type: PostGQL,
        args: { id: { type: new GraphQLNonNull(UUIDType) } },
        resolve: (_, args: {id: string }) => postLoader.load(args.id),
      },
    }
  });

  const schema = new GraphQLSchema({
    query: RootQueryType,
  });

  fastify.route({
    url: '/',
    method: 'POST',
    schema: {
      ...createGqlResponseSchema,
      response: {
        200: gqlResponseSchema,
      },
    },
    async handler(req) {
      return graphql({
        schema,
        source: req.body.query,
        contextValue: { prisma, loaders: { memberTypeLoader } },
      });
    },
  });
};

export default plugin;
