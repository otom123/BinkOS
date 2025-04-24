import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { NetworkName } from '../../..';
import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { MessagesPlaceholder } from '@langchain/core/prompts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { AgentState, createReactAgent, ToolNode } from '@langchain/langgraph/prebuilt';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { shouldBindTools } from '../utils/llm';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';

const createToolCallId = () => {
  // random 5 characters
  return Math.random().toString(36).substring(2, 8);
};

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  chat_history: Annotation<BaseMessage[]>,
  input: Annotation<string>,
  plans: Annotation<
    {
      title: string;
      tasks: { title: string; status: string; retry?: number; result?: string; index: number }[];
      plan_id: string;
      status: string;
    }[]
  >,
  answer: Annotation<string>,
  active_plan_id: Annotation<string>,
  ended_by: Annotation<string>,
  interrupted_request: Annotation<string>,
});

export class BasicQuestionGraph {
  private model: BaseLanguageModel;
  private prompt: string;
  private tools: DynamicStructuredTool[];

  constructor({
    model,
    prompt,
    tools,
  }: {
    model: BaseLanguageModel;
    prompt: string;
    tools: DynamicStructuredTool[];
  }) {
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
  }

  routeAfterAgent(state: typeof StateAnnotation.State) {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

    // If no tools are called, we can finish (respond to the user)
    if (!lastMessage?.tool_calls?.length) {
      return END;
    }

    if (state.ended_by === 'basic_question') {
      return END;
    }
    // Otherwise if there are tool calls, we continue to execute them
    return 'tools';
  }

  async agentNode(state: typeof StateAnnotation.State) {
    let modelWithTools;
    let input;

    if (shouldBindTools(this.model, this.tools)) {
      if (!('bindTools' in this.model) || typeof this.model.bindTools !== 'function') {
        throw new Error(`llm ${this.model} must define bindTools method.`);
      }
      modelWithTools = this.model.bind({
        tools: this.tools.map(t => convertToOpenAITool(t)),
      } as any);
    } else {
      modelWithTools = this.model;
    }

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.prompt],
      new MessagesPlaceholder('chat_history'),
      ['human', '{input}'],
      new MessagesPlaceholder('messages'),
    ]);

    input = state.interrupted_request || state.input;

    const agent = prompt.pipe(
      modelWithTools.withConfig({
        tags: ['final_node'],
      }),
    );

    const responseMessage = await agent.invoke({
      input: input,
      messages: [...(state.messages ?? [])],
      chat_history: [...(state.chat_history ?? [])],
    });

    if (responseMessage.tool_calls?.length) {
      return {
        messages: [responseMessage],
      };
    } else {
      return {
        answer: responseMessage.content,
      };
    }
  }

  create() {
    const executorGraph = new StateGraph(StateAnnotation)
      .addNode('agent', this.agentNode.bind(this))
      .addNode('tools', new ToolNode(this.tools))
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', this.routeAfterAgent, {
        __end__: END,
        tools: 'tools',
      })
      .addEdge('tools', 'agent');

    return executorGraph.compile();
  }
}
