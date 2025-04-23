import { BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { BaseLanguageModel } from '@langchain/core/language_models/base';
import { MessagesPlaceholder } from '@langchain/core/prompts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { shouldBindTools } from '../utils/llm';
import { CreatePlanTool } from '../tools/CreatePlanTool';
import { BaseAgent } from '../../BaseAgent';
import { UpdatePlanTool } from '../tools/UpdatePlanTool';
import { SelectTasksTool } from '../tools/SelectTasksTool';
import { TerminateTool } from '../tools/TerminateTool';

const StateAnnotation = Annotation.Root({
  executor_input: Annotation<string>,
  input: Annotation<string>,
  executor_response_tools: Annotation<ToolMessage[]>,
  plans: Annotation<
    {
      title: string;
      tasks: { title: string; status: string; retry?: number; result?: string; index: number }[];
      plan_id: string;
      status: string;
    }[]
  >,
  active_plan_id: Annotation<string>,
  selected_task_indexes: Annotation<number[]>,
  next_node: Annotation<string>,
  answer: Annotation<string>,
  chat_history: Annotation<BaseMessage[]>,
  ask_question: Annotation<string>,
  ended_by: Annotation<string>,
  thread_id: Annotation<string>,
});

export class PlannerGraph {
  private model: BaseLanguageModel;
  private createPlanPrompt: string;
  private updatePlanPrompt: string;
  private activeTasksPrompt: string;
  private listToolsPrompt: string;
  private agent: BaseAgent;
  private answerPrompt: string;
  private _processedThreads: Set<string> = new Set();
  constructor({
    model,
    createPlanPrompt,
    updatePlanPrompt,
    activeTasksPrompt,
    listToolsPrompt,
    answerPrompt,
    agent,
  }: {
    model: BaseLanguageModel;
    createPlanPrompt: string;
    updatePlanPrompt: string;
    activeTasksPrompt: string;
    answerPrompt: string;
    listToolsPrompt: string;
    agent: BaseAgent;
  }) {
    this.model = model;
    this.createPlanPrompt = createPlanPrompt;
    this.updatePlanPrompt = updatePlanPrompt;
    this.activeTasksPrompt = activeTasksPrompt;
    this.listToolsPrompt = listToolsPrompt;
    this.answerPrompt = answerPrompt;
    this.agent = agent;
  }

  async createPlanNode(state: typeof StateAnnotation.State) {
    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        this.createPlanPrompt +
          `
        Available tools with their names as actions they perform:
        {toolsStr}

        Create a plan using these services to execute the user's request.

        Use chat history only for retrieving context, do not create a new plan based on chat history unless explicitly requested by the user
      `,
      ],
      new MessagesPlaceholder('chat_history'),
      ['human', `Plan to execute the user's request: {input}`],
    ]);

    const createPlanTool = new CreatePlanTool();

    const wrappedCreatePlanTool = this.agent.addTool2CallbackManager(createPlanTool);

    const tools = [wrappedCreatePlanTool];
    let modelWithTools;
    if (shouldBindTools(this.model, tools)) {
      if (!('bindTools' in this.model) || typeof this.model.bindTools !== 'function') {
        throw new Error(`llm ${this.model} must define bindTools method.`);
      }
      console.log('binding tools');
      modelWithTools = this.model.bindTools(tools, {
        tool_choice: 'required',
      });
    } else {
      modelWithTools = this.model;
    }

    const planAgent = prompt.pipe(modelWithTools);

    const response = (await planAgent.invoke({
      input: state.input,
      toolsStr: this.listToolsPrompt,
      chat_history: [...(state.chat_history ?? [])],
    })) as any;

    if (response?.tool_calls) {
      const toolCall = response.tool_calls[0];
      const toolName = toolCall.name;
      const toolArgs = toolCall.args;
      const tool = tools.find(t => t.name === toolName);
      const result = await tool?.invoke(toolArgs);
      if (toolName === 'create_plan') {
        return {
          plans: result,
        };
      }
    }
    return response;
  }

  async updatePlanNode(state: typeof StateAnnotation.State) {
    const promptActiveTask = `Active task: ${state.active_plan_id}, Selected task indexes: ${state.selected_task_indexes}`;

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.updatePlanPrompt],
      ['human', 'The current plans: {plans}'],
      new MessagesPlaceholder('executor_response_tools'),
      ['human', `Update current plan: ${promptActiveTask}`],
    ]);

    const updatePlanTool = new UpdatePlanTool();
    const wrappedUpdatePlanTool = this.agent.addTool2CallbackManager(updatePlanTool);

    const tools = [wrappedUpdatePlanTool];
    let modelWithTools;
    if (shouldBindTools(this.model, tools)) {
      if (!('bindTools' in this.model) || typeof this.model.bindTools !== 'function') {
        throw new Error(`llm ${this.model} must define bindTools method.`);
      }
      console.log('binding tools');
      modelWithTools = this.model.bind({
        tools: tools.map(t => convertToOpenAITool(t)),
        tool_choice: 'required',
      } as any);
    } else {
      modelWithTools = this.model;
    }

    const planAgent = prompt.pipe(modelWithTools);
    let responseTools = state.executor_response_tools ?? [];

    // Remove executor tool if there are any other tools
    if (responseTools.filter((tool: ToolMessage) => tool.name != 'executor').length > 0) {
      responseTools = responseTools.filter((tool: ToolMessage) => tool.name != 'executor');
    }

    const toolMessages = responseTools.map((m: ToolMessage) => {
      return new HumanMessage(
        `Response tool id: ${m.tool_call_id}\n Tool name: ${m.name} \n ${m.content}`,
      );
    });

    const currentPlan = state.plans.find(plan => plan.plan_id === state.active_plan_id);

    const response = (await planAgent.invoke({
      input: state.input,
      toolsStr: this.listToolsPrompt,
      plans: JSON.stringify(currentPlan),
      executor_response_tools: toolMessages,
    })) as any;

    if (response?.tool_calls) {
      const updatePlanToolCalls = response.tool_calls.filter(
        (toolCall: any) => toolCall.name === 'update_plan',
      );
      if (updatePlanToolCalls.length > 0) {
        const tasks = updatePlanToolCalls.map((toolCall: any) => toolCall.args.tasks).flat();
        const result = await wrappedUpdatePlanTool.invoke({
          plan_id: updatePlanToolCalls[0].args.plan_id,
          tasks,
        });
        return {
          plans: result,
        };
      }
    }
    return response;
  }

  async selectTasksNode(state: typeof StateAnnotation.State) {
    // check if any task retry > 3, if so, terminate the plan
    const planToTerminate = state.plans.find((plan: any) => {
      return plan.tasks.some((task: any) => task.status === 'failed' && task.retry > 3);
    });
    if (planToTerminate) {
      return {
        next_node: 'end',
      };
    }

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.activeTasksPrompt],
      ['human', `The current plan: {plan}`],
    ]);

    const selectTasksTool = new SelectTasksTool();
    const wrappedSelectTasksTool = this.agent.addTool2CallbackManager(selectTasksTool);

    const terminateTool = new TerminateTool();
    const wrappedTerminateTool = this.agent.addTool2CallbackManager(terminateTool);

    const tools = [wrappedSelectTasksTool, wrappedTerminateTool];
    let modelWithTools;
    if (shouldBindTools(this.model, tools)) {
      if (!('bindTools' in this.model) || typeof this.model.bindTools !== 'function') {
        throw new Error(`llm ${this.model} must define bindTools method.`);
      }
      modelWithTools = this.model.bind({
        tools: tools.map(t => convertToOpenAITool(t)),
        tool_choice: 'required',
      } as any);
    } else {
      modelWithTools = this.model;
    }

    const planAgent = prompt.pipe(modelWithTools);

    const response = (await planAgent.invoke({
      input: state.input,
      plan: JSON.stringify(state.plans),
    })) as any;

    if (response?.tool_calls) {
      const toolCall = response.tool_calls[0];
      const toolName = toolCall.name;
      const toolArgs = toolCall.args;
      const tool = tools.find(t => t.name === toolName);
      if (toolName === 'select_tasks') {
        const next_input = await tool?.invoke(toolArgs);
        return {
          selected_task_indexes: toolArgs.task_indexes,
          active_plan_id: toolArgs.plan_id,
          executor_input: next_input,
          next_node: END,
          answer: null,
        };
      } else if (toolName === 'terminate') {
        return {
          next_node: 'planning_answer',
        };
      }
    }
  }

  shouldCreateOrUpdatePlan(state: typeof StateAnnotation.State): string {
    let isNewThread = false;

    if (state.thread_id && this._processedThreads) {
      isNewThread = !this._processedThreads.has(state.thread_id);
    }

    // Track that we've processed this thread
    if (isNewThread) {
      this._processedThreads.add(state.thread_id);
      return 'create_plan';
    }

    // Check if no plans exist
    if (!state?.plans || state?.plans.length === 0) {
      return 'create_plan';
    }

    // Check if active plan is complete
    const activePlan = state.plans?.find(plan => plan.plan_id === state.active_plan_id);
    const isLastActivePlanCompleted = activePlan?.status === 'completed';
    const isLastActivePlanRejected = activePlan?.status === 'rejected';

    const wasEndedByPlanner = state.ended_by === 'planner_answer';
    const wasEndedByRejectTransaction = state.ended_by === 'reject_transaction';

    return (isLastActivePlanCompleted && wasEndedByPlanner) ||
      (isLastActivePlanRejected && wasEndedByRejectTransaction)
      ? 'create_plan'
      : 'update_plan';
  }

  async answerNode(state: typeof StateAnnotation.State) {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.answerPrompt || ''],
      new MessagesPlaceholder('chat_history'),
      ['human', `{input}`],
      ['human', 'plans: {plans}'],
      ['system', 'You need to response user after execute the plan'],
    ]);

    const response = await prompt
      .pipe(
        this.model.withConfig({
          tags: ['final_node'],
        }),
      )
      .invoke({
        input: state.input,
        plans: JSON.stringify(state.plans),
        chat_history: state.chat_history || [],
      });

    return {
      chat_history: [response],
      answer: response.content,
      next_node: END,
      ended_by: 'planner_answer',
    };
  }

  create() {
    const plannerGraph = new StateGraph(StateAnnotation)
      .addNode('create_plan', this.createPlanNode.bind(this))
      .addNode('update_plan', this.updatePlanNode.bind(this))
      .addNode('select_tasks', this.selectTasksNode.bind(this))
      .addNode('planning_answer', this.answerNode.bind(this))
      .addNode('end', () => {
        return {};
      })
      .addConditionalEdges(START, this.shouldCreateOrUpdatePlan, {
        create_plan: 'create_plan',
        update_plan: 'update_plan',
      })
      .addConditionalEdges(
        'select_tasks',
        (state: typeof StateAnnotation.State) => {
          return state.next_node === END && state.answer == null ? 'end' : 'planning_answer';
        },
        {
          end: 'end',
          planning_answer: 'planning_answer',
        },
      )
      .addEdge('create_plan', 'select_tasks')
      .addEdge('update_plan', 'select_tasks')
      .addEdge('planning_answer', 'end')
      .addEdge('end', END);

    return plannerGraph.compile();
  }
}
