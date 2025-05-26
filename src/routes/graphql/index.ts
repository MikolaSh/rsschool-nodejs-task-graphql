import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createGqlResponseSchema, gqlResponseSchema } from './schemas.js';
import { graphql, GraphQLEnumType, GraphQLFloat, GraphQLInt, GraphQLNonNull, GraphQLObjectType, validate } from 'graphql';
import { MemberType } from '@prisma/client';
import { MemberTypeId } from '../member-types/schemas.js';
import DataLoader from 'dataloader';

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


  const RootQueryType = new GraphQLObjectType({
    fields: {
      memberTypes: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberTypeGQL))),
        resolve: () => prisma.memberType.findMany(),
      },
      memberType: {
        type: MemberTypeGQL,
        args: { id: { type: new GraphQLNonNull(MemberTypeIdGQL) } },
        resolve: (_, args) => memberTypeLoader.load(args.id),
      },
    }
  })

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
      // return graphql();
    },
  });
};

export default plugin;
