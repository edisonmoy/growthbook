import cloneDeep from "lodash/cloneDeep";
import { dateStringArrayBetweenDates, getValidDate } from "shared/dates";
import normal from "@stdlib/stats/base/dists/normal";
import { format as formatDate, subDays } from "date-fns";
import {
  getConversionWindowHours,
  getUserIdTypes,
  isFactMetric,
  isFunnelMetric,
  isRatioMetric,
  isRegressionAdjusted,
  ExperimentMetricInterface,
  getMetricTemplateVariables,
  quantileMetricType,
  getColumnRefWhereClause,
  getAggregateFilters,
  isBinomialMetric,
  getDelayWindowHours,
  getColumnExpression,
} from "shared/experiments";
import {
  AUTOMATIC_DIMENSION_OTHER_NAME,
  DEFAULT_TEST_QUERY_DAYS,
  DEFAULT_METRIC_HISTOGRAM_BINS,
  BANDIT_SRM_DIMENSION_NAME,
  SAFE_ROLLOUT_TRACKING_KEY_PREFIX,
} from "shared/constants";
import { ensureLimit, format, SQL_ROW_LIMIT } from "shared/sql";
import { FormatDialect } from "shared/src/types";
import { MetricAnalysisSettings } from "back-end/types/metric-analysis";
import { UNITS_TABLE_PREFIX } from "back-end/src/queryRunners/ExperimentResultsQueryRunner";
import { ReqContext } from "back-end/types/organization";
import { MetricInterface, MetricType } from "back-end/types/metric";
import {
  DataSourceSettings,
  DataSourceProperties,
  ExposureQuery,
  SchemaFormatConfig,
  DataSourceInterface,
  AutoFactTableSchemas,
  SchemaFormat,
} from "back-end/types/datasource";
import {
  MetricValueParams,
  SourceIntegrationInterface,
  ExperimentMetricQueryParams,
  PastExperimentParams,
  PastExperimentQueryResponse,
  ExperimentMetricQueryResponse,
  MetricValueQueryResponse,
  MetricValueQueryResponseRow,
  ExperimentQueryResponses,
  Dimension,
  TestQueryResult,
  InformationSchema,
  RawInformationSchema,
  MissingDatasourceParamsError,
  ExperimentUnitsQueryParams,
  QueryResponse,
  TrackedEventResponseRow,
  ExperimentUnitsQueryResponse,
  ProcessedDimensions,
  ExperimentAggregateUnitsQueryResponse,
  ExperimentAggregateUnitsQueryParams,
  UserDimension,
  ExperimentDimension,
  ExternalIdCallback,
  DimensionSlicesQueryResponse,
  DimensionSlicesQueryParams,
  ExperimentFactMetricsQueryParams,
  ExperimentFactMetricsQueryResponse,
  FactMetricData,
  BanditMetricData,
  MetricAnalysisParams,
  MetricAnalysisQueryResponse,
  MetricAnalysisQueryResponseRow,
  TrackedEventData,
  AutoMetricTrackedEvent,
  AutoMetricToCreate,
  DropTableQueryResponse,
  DropTableQueryParams,
  TestQueryParams,
  ColumnTopValuesParams,
  ColumnTopValuesResponse,
  PopulationMetricQueryParams,
  PopulationFactMetricsQueryParams,
  VariationPeriodWeight,
} from "back-end/src/types/Integration";
import { DimensionInterface } from "back-end/types/dimension";
import { SegmentInterface } from "back-end/types/segment";
import {
  getBaseIdTypeAndJoins,
  compileSqlTemplate,
  replaceCountStar,
} from "back-end/src/util/sql";
import { formatInformationSchema } from "back-end/src/util/informationSchemas";
import {
  ExperimentSnapshotSettings,
  SnapshotBanditSettings,
  SnapshotSettingsVariation,
} from "back-end/types/experiment-snapshot";
import { SQLVars, TemplateVariables } from "back-end/types/sql";
import { FactTableMap } from "back-end/src/models/FactTableModel";
import { logger } from "back-end/src/util/logger";
import {
  ColumnRef,
  FactMetricInterface,
  FactTableInterface,
  MetricQuantileSettings,
} from "back-end/types/fact-table";
import { applyMetricOverrides } from "back-end/src/util/integration";
import { ReqContextClass } from "back-end/src/services/context";
import { PopulationDataQuerySettings } from "back-end/src/queryRunners/PopulationDataQueryRunner";

export const MAX_ROWS_UNIT_AGGREGATE_QUERY = 3000;
export const MAX_ROWS_PAST_EXPERIMENTS_QUERY = 3000;
export const TEST_QUERY_SQL = "SELECT 1";

const N_STAR_VALUES = [
  100,
  200,
  400,
  800,
  1600,
  3200,
  6400,
  12800,
  25600,
  51200,
  102400,
  204800,
  409600,
  819200,
  1638400,
  3276800,
  6553600,
  13107200,
  26214400,
  52428800,
];

const supportedEventTrackers: Record<AutoFactTableSchemas, true> = {
  segment: true,
  rudderstack: true,
  amplitude: true,
};

export default abstract class SqlIntegration
  implements SourceIntegrationInterface {
  datasource: DataSourceInterface;
  context: ReqContext;
  decryptionError: boolean;
  // eslint-disable-next-line
  params: any;
  abstract setParams(encryptedParams: string): void;
  abstract runQuery(
    sql: string,
    setExternalId?: ExternalIdCallback
  ): Promise<QueryResponse>;
  async cancelQuery(externalId: string): Promise<void> {
    logger.debug(`Cancel query: ${externalId} - not implemented`);
  }
  abstract getSensitiveParamKeys(): string[];

  constructor(context: ReqContextClass, datasource: DataSourceInterface) {
    this.datasource = datasource;
    this.context = context;
    this.decryptionError = false;
    try {
      this.setParams(datasource.params);
    } catch (e) {
      this.params = {};
      this.decryptionError = true;
    }
  }
  getSourceProperties(): DataSourceProperties {
    return {
      queryLanguage: "sql",
      metricCaps: true,
      segments: true,
      dimensions: true,
      exposureQueries: true,
      separateExperimentResultQueries: true,
      hasSettings: true,
      userIds: true,
      experimentSegments: true,
      activationDimension: true,
      pastExperiments: true,
      supportsInformationSchema: true,
      supportsAutoGeneratedMetrics: this.isAutoGeneratingMetricsSupported(),
      supportsWritingTables: this.isWritingTablesSupported(),
      dropUnitsTable: this.dropUnitsTable(),
      hasQuantileTesting: this.hasQuantileTesting(),
      hasEfficientPercentiles: this.hasEfficientPercentile(),
      hasCountDistinctHLL: this.hasCountDistinctHLL(),
    };
  }

  async testConnection(): Promise<boolean> {
    await this.runQuery(TEST_QUERY_SQL);
    return true;
  }

  isAutoGeneratingFactTablesSupported(): boolean {
    if (
      this.datasource.settings.schemaFormat &&
      supportedEventTrackers[
        this.datasource.settings.schemaFormat as AutoFactTableSchemas
      ]
    ) {
      return true;
    }
    return false;
  }

  // Currently, if auto generating fact tables is supported, so is generating auto metrics
  isAutoGeneratingMetricsSupported(): boolean {
    return this.isAutoGeneratingFactTablesSupported();
  }

  schemaFormatisAutoFactTablesSchemas(
    schemaFormat: SchemaFormat
  ): schemaFormat is AutoFactTableSchemas {
    return (
      supportedEventTrackers[schemaFormat as AutoFactTableSchemas] || false
    );
  }

  isWritingTablesSupported(): boolean {
    return false;
  }

  dropUnitsTable(): boolean {
    return false;
  }

  requiresDatabase = true;
  requiresSchema = true;
  requiresEscapingPath = false;

  getSchema(): string {
    return "";
  }
  getFormatDialect(): FormatDialect {
    return "";
  }
  toTimestamp(date: Date) {
    return `'${date.toISOString().substr(0, 19).replace("T", " ")}'`;
  }
  addHours(col: string, hours: number) {
    if (!hours) return col;
    let unit: "hour" | "minute" = "hour";
    const sign = hours > 0 ? "+" : "-";
    hours = Math.abs(hours);

    const roundedHours = Math.round(hours);
    const roundedMinutes = Math.round(hours * 60);

    let amount = roundedHours;

    // If minutes are needed, use them
    if (roundedMinutes % 60 > 0) {
      unit = "minute";
      amount = roundedMinutes;
    }

    if (amount === 0) {
      return col;
    }

    return this.addTime(col, unit, sign, amount);
  }
  addTime(
    col: string,
    unit: "hour" | "minute",
    sign: "+" | "-",
    amount: number
  ): string {
    return `${col} ${sign} INTERVAL '${amount} ${unit}s'`;
  }
  dateTrunc(col: string) {
    return `date_trunc('day', ${col})`;
  }
  dateDiff(startCol: string, endCol: string) {
    return `datediff(day, ${startCol}, ${endCol})`;
  }
  formatDate(col: string): string {
    return col;
  }
  ifElse(condition: string, ifTrue: string, ifFalse: string) {
    return `(CASE WHEN ${condition} THEN ${ifTrue} ELSE ${ifFalse} END)`;
  }
  castToString(col: string): string {
    return `cast(${col} as varchar)`;
  }
  castToDate(col: string): string {
    return `CAST(${col} AS DATE)`;
  }
  ensureFloat(col: string): string {
    return col;
  }
  escapeStringLiteral(value: string): string {
    return value.replace(/'/g, `''`);
  }
  castUserDateCol(column: string): string {
    return column;
  }
  formatDateTimeString(col: string): string {
    return this.castToString(col);
  }
  selectStarLimit(table: string, limit: number): string {
    return `SELECT * FROM ${table} LIMIT ${limit}`;
  }

  ensureMaxLimit(sql: string, limit: number): string {
    return ensureLimit(sql, limit);
  }

  hasQuantileTesting(): boolean {
    return true;
  }
  hasEfficientPercentile(): boolean {
    return true;
  }
  hasCountDistinctHLL(): boolean {
    return false;
  }
  // eslint-disable-next-line
  hllAggregate(col: string): string {
    throw new Error(
      "COUNT DISTINCT is not supported for fact metrics in this data source."
    );
  }
  // eslint-disable-next-line
  hllReaggregate(col: string): string {
    throw new Error(
      "COUNT DISTINCT is not supported for fact metrics in this data source."
    );
  }
  // eslint-disable-next-line
  hllCardinality(col: string): string {
    throw new Error(
      "COUNT DISTINCT is not supported for fact metrics in this data source."
    );
  }

  extractJSONField(jsonCol: string, path: string, isNumeric: boolean): string {
    const raw = `json_extract_scalar(${jsonCol}, '$.${path}')`;
    return isNumeric ? this.ensureFloat(raw) : raw;
  }

  private getExposureQuery(
    exposureQueryId: string,
    userIdType?: "anonymous" | "user"
  ): ExposureQuery {
    if (!exposureQueryId) {
      exposureQueryId = userIdType === "user" ? "user_id" : "anonymous_id";
    }

    const queries = this.datasource.settings?.queries?.exposure || [];

    const match = queries.find((q) => q.id === exposureQueryId);

    if (!match) {
      throw new Error(
        "Unknown experiment assignment table - " + exposureQueryId
      );
    }

    return match;
  }

  getPastExperimentQuery(params: PastExperimentParams): string {
    // TODO: for past experiments, UNION all exposure queries together
    const experimentQueries = (
      this.datasource.settings.queries?.exposure || []
    ).map(({ id }) => this.getExposureQuery(id));

    const end = new Date();

    return format(
      `-- Past Experiments
    WITH
      ${experimentQueries
        .map((q, i) => {
          const hasNameCol = q.hasNameCol || false;
          return `
        __exposures${i} as (
          SELECT 
            ${this.castToString(`'${q.id}'`)} as exposure_query,
            experiment_id,
            ${
              hasNameCol ? "MIN(experiment_name)" : "experiment_id"
            } as experiment_name,
            ${this.castToString("variation_id")} as variation_id,
            ${
              hasNameCol
                ? "MIN(variation_name)"
                : this.castToString("variation_id")
            } as variation_name,
            ${this.dateTrunc(this.castUserDateCol("timestamp"))} as date,
            count(distinct ${q.userIdType}) as users,
            MAX(${this.castUserDateCol("timestamp")}) as latest_data
          FROM
            (
              ${compileSqlTemplate(q.query, { startDate: params.from })}
            ) e${i}
          WHERE
            timestamp > ${this.toTimestamp(params.from)}
            AND timestamp <= ${this.toTimestamp(end)}
            AND SUBSTRING(experiment_id, 1, ${
              SAFE_ROLLOUT_TRACKING_KEY_PREFIX.length
            }) != '${SAFE_ROLLOUT_TRACKING_KEY_PREFIX}'
          GROUP BY
            experiment_id,
            variation_id,
            ${this.dateTrunc(this.castUserDateCol("timestamp"))}
        ),`;
        })
        .join("\n")}
      __experiments as (
        ${experimentQueries
          .map((q, i) => `SELECT * FROM __exposures${i}`)
          .join("\nUNION ALL\n")}
      ),
      __userThresholds as (
        SELECT
          exposure_query,
          experiment_id,
          MIN(experiment_name) as experiment_name,
          variation_id,
          MIN(variation_name) as variation_name,
          -- It's common for a small number of tracking events to continue coming in
          -- long after an experiment ends, so limit to days with enough traffic
          max(users)*0.05 as threshold
        FROM
          __experiments
        WHERE
          -- Skip days where a variation got 5 or fewer visitors since it's probably not real traffic
          users > 5
        GROUP BY
        exposure_query, experiment_id, variation_id
      ),
      __variations as (
        SELECT
          d.exposure_query,
          d.experiment_id,
          MIN(d.experiment_name) as experiment_name,
          d.variation_id,
          MIN(d.variation_name) as variation_name,
          MIN(d.date) as start_date,
          MAX(d.date) as end_date,
          SUM(d.users) as users,
          MAX(latest_data) as latest_data
        FROM
          __experiments d
          JOIN __userThresholds u ON (
            d.exposure_query = u.exposure_query
            AND d.experiment_id = u.experiment_id
            AND d.variation_id = u.variation_id
          )
        WHERE
          d.users > u.threshold
        GROUP BY
          d.exposure_query, d.experiment_id, d.variation_id
      )
    ${this.selectStarLimit(
      `
      __variations
    ORDER BY
      start_date DESC, experiment_id ASC, variation_id ASC
      `,
      MAX_ROWS_PAST_EXPERIMENTS_QUERY
    )}`,
      this.getFormatDialect()
    );
  }
  async runPastExperimentQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<PastExperimentQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);

    return {
      rows: rows.map((row) => {
        return {
          exposure_query: row.exposure_query,
          experiment_id: row.experiment_id,
          experiment_name: row.experiment_name,
          variation_id: row.variation_id ?? "",
          variation_name: row.variation_name,
          users: parseInt(row.users) || 0,
          end_date: getValidDate(row.end_date).toISOString(),
          start_date: getValidDate(row.start_date).toISOString(),
          latest_data: getValidDate(row.latest_data).toISOString(),
        };
      }),
      statistics: statistics,
    };
  }

  getMetricValueQuery(params: MetricValueParams): string {
    const { baseIdType, idJoinMap, idJoinSQL } = this.getIdentitiesCTE({
      objects: [
        params.metric.userIdTypes || [],
        params.segment ? [params.segment.userIdType || "user_id"] : [],
      ],
      from: params.from,
      to: params.to,
    });

    // Get rough date filter for metrics to improve performance
    const metricStart = this.getMetricStart(
      params.from,
      this.getMetricMinDelay([params.metric]),
      0
    );
    const metricEnd = this.getMetricEnd([params.metric], params.to);

    const aggregate = this.getAggregateMetricColumn({
      metric: params.metric,
    });

    // TODO query is broken if segment has template variables
    return format(
      `-- ${params.name} - ${params.metric.name} Metric
      WITH
        ${idJoinSQL}
        ${
          params.segment
            ? `segment as (${this.getSegmentCTE(
                params.segment,
                baseIdType,
                idJoinMap,
                params.factTableMap
              )}),`
            : ""
        }
        __metric as (${this.getMetricCTE({
          metric: params.metric,
          baseIdType,
          idJoinMap,
          startDate: metricStart,
          endDate: metricEnd,
          // Facts tables are not supported for this query yet
          factTableMap: new Map(),
        })})
        , __userMetric as (
          -- Add in the aggregate metric value for each user
          SELECT
            ${aggregate} as value
          FROM
            __metric m
            ${
              params.segment
                ? `JOIN segment s ON (s.${baseIdType} = m.${baseIdType}) WHERE s.date <= m.timestamp`
                : ""
            }
          GROUP BY
            m.${baseIdType}
        )
        , __overall as (
          SELECT
            COUNT(*) as count,
            COALESCE(SUM(value), 0) as main_sum,
            COALESCE(SUM(POWER(value, 2)), 0) as main_sum_squares
          from
            __userMetric
        )
        ${
          params.includeByDate
            ? `
          , __userMetricDates as (
            -- Add in the aggregate metric value for each user
            SELECT
              ${this.dateTrunc("m.timestamp")} as date,
              ${aggregate} as value
            FROM
              __metric m
              ${
                params.segment
                  ? `JOIN segment s ON (s.${baseIdType} = m.${baseIdType}) WHERE s.date <= m.timestamp`
                  : ""
              }
            GROUP BY
              ${this.dateTrunc("m.timestamp")},
              m.${baseIdType}
          )
          , __byDateOverall as (
            SELECT
              date,
              COUNT(*) as count,
              COALESCE(SUM(value), 0) as main_sum,
              COALESCE(SUM(POWER(value, 2)), 0) as main_sum_squares
            FROM
              __userMetricDates d
            GROUP BY
              date
          )`
            : ""
        }
      ${
        params.includeByDate
          ? `
        , __union as (
          SELECT 
            null as date,
            o.*
          FROM
            __overall o
          UNION ALL
          SELECT
            d.*
          FROM
            __byDateOverall d
        )
        SELECT
          *
        FROM
          __union
        ORDER BY
          date ASC
      `
          : `
        SELECT
          o.*
        FROM
          __overall o
      `
      }
      
      `,
      this.getFormatDialect()
    );
  }

  getPowerPopulationSourceCTE({
    settings,
    factTableMap,
    segment,
  }: {
    settings: PopulationDataQuerySettings;
    factTableMap: FactTableMap;
    segment: SegmentInterface | null;
  }) {
    switch (settings.sourceType) {
      case "segment": {
        if (segment) {
          const factTable = segment.factTableId
            ? factTableMap.get(segment.factTableId)
            : undefined;
          return `
          __source AS (${this.getSegmentCTE(
            segment,
            settings.userIdType,
            {}, // no id join map needed as id type is segment id type
            factTableMap,
            {
              startDate: settings.startDate,
              endDate: settings.endDate ?? undefined,
              templateVariables: { eventName: factTable?.eventName },
            }
          )})`;
        } else {
          throw new Error("Segment not found");
        }
      }
      case "factTable": {
        const factTable = factTableMap.get(settings.sourceId);
        if (factTable) {
          const sql = factTable.sql;
          return compileSqlTemplate(
            `
          __source AS (
            SELECT
              ${settings.userIdType}
              , timestamp
            FROM (
              ${sql}
            ) ft
          )`,
            {
              startDate: settings.startDate,
              endDate: settings.endDate ?? undefined,
              templateVariables: { eventName: factTable.eventName },
            }
          );
        } else {
          throw new Error("Fact Table not found");
        }
      }
    }
  }

  getPowerPopulationCTEs({
    settings,
    factTableMap,
    segment,
  }: {
    settings: PopulationDataQuerySettings;
    factTableMap: FactTableMap;
    segment: SegmentInterface | null;
  }): string {
    const timestampColumn =
      settings.sourceType === "segment" ? "date" : "timestamp";
    // BQ datetime cast for SELECT statements (do not use for where)
    const timestampDateTimeColumn = this.castUserDateCol(timestampColumn);

    const firstQuery = this.getPowerPopulationSourceCTE({
      settings,
      factTableMap,
      segment,
    });

    return `
      ${firstQuery}
      , __experimentUnits AS (
        SELECT
          ${settings.userIdType}
          , MIN(${timestampDateTimeColumn}) AS first_exposure_timestamp
          , ${this.castToString("''")} as variation
        FROM
          __source
        WHERE
            ${timestampColumn} >= ${this.toTimestamp(settings.startDate)}
            AND ${timestampColumn} <= ${this.toTimestamp(settings.endDate)}
        GROUP BY ${settings.userIdType}
      ),`;
  }

  getMetricAnalysisPopulationCTEs({
    settings,
    idJoinMap,
    factTableMap,
    segment,
  }: {
    settings: MetricAnalysisSettings;
    idJoinMap: Record<string, string>;
    factTableMap: FactTableMap;
    segment: SegmentInterface | null;
  }): string {
    // get population query
    if (settings.populationType === "exposureQuery") {
      const exposureQuery = this.getExposureQuery(settings.populationId || "");

      return `
      __rawExperiment AS (
        ${compileSqlTemplate(exposureQuery.query, {
          startDate: settings.startDate,
          endDate: settings.endDate ?? undefined,
        })}
      ),
      __population AS (
        -- All recent users
        SELECT DISTINCT
          ${settings.userIdType}
        FROM
            __rawExperiment
        WHERE
            timestamp >= ${this.toTimestamp(settings.startDate)}
            ${
              settings.endDate
                ? `AND timestamp <= ${this.toTimestamp(settings.endDate)}`
                : ""
            }
        ),`;
    }

    if (settings.populationType === "segment" && segment) {
      // TODO segment missing
      return `
      __segment as (${this.getSegmentCTE(
        segment,
        settings.userIdType,
        idJoinMap,
        factTableMap,
        {
          startDate: settings.startDate,
          endDate: settings.endDate ?? undefined,
        }
      )}),
      __population AS (
        SELECT DISTINCT
          ${settings.userIdType}
        FROM
          __segment e
        WHERE
            date >= ${this.toTimestamp(settings.startDate)}
            ${
              settings.endDate
                ? `AND date <= ${this.toTimestamp(settings.endDate)}`
                : ""
            }
      ),`;
    }

    return "";
  }

  getMetricAnalysisStatisticClauses(
    finalValueColumn: string,
    finalDenominatorColumn: string,
    ratioMetric: boolean
  ): string {
    return `, COUNT(*) as units
            , SUM(${finalValueColumn}) as main_sum
            , SUM(POWER(${finalValueColumn}, 2)) as main_sum_squares
            ${
              ratioMetric
                ? `
            , SUM(${finalDenominatorColumn}) as denominator_sum
            , SUM(POWER(${finalDenominatorColumn}, 2)) as denominator_sum_squares
            , SUM(${finalDenominatorColumn} * ${finalValueColumn}) as main_denominator_sum_product
            `
                : ""
            }`;
  }

  getMetricAnalysisQuery(params: MetricAnalysisParams): string {
    const { metric, settings } = params;

    // Get any required identity join queries; only use same id type for now,
    // so not needed
    const idTypeObjects = [
      getUserIdTypes(metric, params.factTableMap),
      //...unitDimensions.map((d) => [d.dimension.userIdType || "user_id"]),
      //settings.segment ? [settings.segment.userIdType || "user_id"] : [],
    ];
    const { baseIdType, idJoinMap, idJoinSQL } = this.getIdentitiesCTE({
      objects: idTypeObjects,
      from: settings.startDate,
      to: settings.endDate ?? undefined,
      forcedBaseIdType: settings.userIdType,
    });
    const metricData = this.getMetricData(
      metric,
      {
        attributionModel: "experimentDuration",
        regressionAdjustmentEnabled: false,
        startDate: settings.startDate,
        endDate: settings.endDate ?? undefined,
      },
      null,
      "m0"
    );

    const createHistogram = metric.metricType === "mean";

    const finalDailyValueColumn = this.capCoalesceValue({
      valueCol: this.getValueFromAggregateColumns("value", metric.numerator),
      metric,
      capTablePrefix: "cap",
      capValueCol: "value_capped",
      columnRef: metric.numerator,
    });
    const finalDailyDenominatorColumn = this.capCoalesceValue({
      valueCol: this.getValueFromAggregateColumns(
        "denominator",
        metric.denominator
      ),
      metric,
      capTablePrefix: "cap",
      capValueCol: "denominator_capped",
      columnRef: metric.denominator,
    });

    const finalOverallValueColumn = this.capCoalesceValue({
      valueCol: "value",
      metric,
      capTablePrefix: "cap",
      capValueCol: "value_capped",
      columnRef: metric.numerator,
    });
    const finalOverallDenominatorColumn = this.capCoalesceValue({
      valueCol: "denominator",
      metric,
      capTablePrefix: "cap",
      capValueCol: "denominator_capped",
      columnRef: metric.denominator,
    });

    const populationSQL = this.getMetricAnalysisPopulationCTEs({
      settings,
      idJoinMap,
      factTableMap: params.factTableMap,
      segment: params.segment,
    });

    // TODO check if query broken if segment has template variables
    // TODO return cap numbers
    return format(
      `-- ${metric.name} Metric Analysis
      WITH
        ${idJoinSQL}
        ${populationSQL}
      __factTable AS (${this.getFactMetricCTE({
        baseIdType,
        idJoinMap,
        metrics: [metric],
        endDate: metricData.metricEnd,
        startDate: metricData.metricStart,
        factTableMap: params.factTableMap,
        addFiltersToWhere: settings.populationType == "metric",
      })})
        , __userMetricDaily AS (
          -- Get aggregated metric per user by day
          SELECT
          ${populationSQL ? "p" : "f"}.${baseIdType} AS ${baseIdType}
            , ${this.dateTrunc("timestamp")} AS date
            , ${this.getAggregateMetricColumn({
              metric: metricData.metric,
              useDenominator: false,
              valueColumn: `f.${metricData.alias}_value`,
              willReaggregate: true,
            })} AS value
                  ${
                    metricData.ratioMetric
                      ? `, ${this.getAggregateMetricColumn({
                          metric: metricData.metric,
                          useDenominator: true,
                          valueColumn: `f.${metricData.alias}_denominator`,
                          willReaggregate: true,
                        })} AS denominator`
                      : ""
                  }
          
          ${
            populationSQL
              ? `
            FROM __population p 
            LEFT JOIN __factTable f ON (f.${baseIdType} = p.${baseIdType})`
              : `
            FROM __factTable f`
          } 
          GROUP BY
            ${this.dateTrunc("f.timestamp")}
            , ${populationSQL ? "p" : "f"}.${baseIdType}
        )
        , __userMetricOverall AS (
          SELECT
            ${baseIdType}
            , ${this.getReaggregateMetricColumn(
              metric,
              false,
              "value"
            )} AS value
             ${
               metricData.ratioMetric
                 ? `, ${this.getReaggregateMetricColumn(
                     metric,
                     true,
                     "denominator"
                   )} AS denominator`
                 : ""
             }
          FROM
            __userMetricDaily
          GROUP BY
            ${baseIdType}
        )
        ${
          metricData.isPercentileCapped
            ? `
        , __capValue AS (
            ${this.percentileCapSelectClause(
              [
                {
                  valueCol: "value",
                  outputCol: "value_capped",
                  percentile: metricData.metric.cappingSettings.value ?? 1,
                  ignoreZeros:
                    metricData.metric.cappingSettings.ignoreZeros ?? false,
                },
                ...(metricData.ratioMetric
                  ? [
                      {
                        valueCol: "denominator",
                        outputCol: "denominator_capped",
                        percentile:
                          metricData.metric.cappingSettings.value ?? 1,
                        ignoreZeros:
                          metricData.metric.cappingSettings.ignoreZeros ??
                          false,
                      },
                    ]
                  : []),
              ],
              "__userMetricOverall"
            )}
        )
        `
            : ""
        }
        , __statisticsDaily AS (
          SELECT
            date
            , MAX(${this.castToString("'date'")}) AS data_type
            , ${this.castToString(
              `'${metric.cappingSettings.type ? "capped" : "uncapped"}'`
            )} AS capped
            ${this.getMetricAnalysisStatisticClauses(
              finalDailyValueColumn,
              finalDailyDenominatorColumn,
              metricData.ratioMetric
            )}
            ${
              createHistogram
                ? `
            , MIN(${finalDailyValueColumn}) as value_min
            , MAX(${finalDailyValueColumn}) as value_max
            , ${this.ensureFloat("NULL")} AS bin_width
            ${[...Array(DEFAULT_METRIC_HISTOGRAM_BINS).keys()]
              .map((i) => `, ${this.ensureFloat("NULL")} AS units_bin_${i}`)
              .join("\n")}`
                : ""
            }
          FROM __userMetricDaily
          ${metricData.isPercentileCapped ? "CROSS JOIN __capValue cap" : ""}
          GROUP BY date
        )
        , __statisticsOverall AS (
          SELECT
            ${this.castToDate("NULL")} AS date
            , MAX(${this.castToString("'overall'")}) AS data_type
            , ${this.castToString(
              `'${metric.cappingSettings.type ? "capped" : "uncapped"}'`
            )} AS capped
            ${this.getMetricAnalysisStatisticClauses(
              finalOverallValueColumn,
              finalOverallDenominatorColumn,
              metricData.ratioMetric
            )}
            ${
              createHistogram
                ? `
            , MIN(${finalOverallValueColumn}) as value_min
            , MAX(${finalOverallValueColumn}) as value_max
            , (MAX(${finalOverallValueColumn}) - MIN(${finalOverallValueColumn})) / ${DEFAULT_METRIC_HISTOGRAM_BINS}.0 as bin_width
            `
                : ""
            }
          FROM __userMetricOverall
        ${metricData.isPercentileCapped ? "CROSS JOIN __capValue cap" : ""}
        )
        ${
          createHistogram
            ? `
        , __histogram AS (
          SELECT
            SUM(${this.ifElse(
              "m.value < (s.value_min + s.bin_width)",
              "1",
              "0"
            )}) as units_bin_0
            ${[...Array(DEFAULT_METRIC_HISTOGRAM_BINS - 2).keys()]
              .map(
                (i) =>
                  `, SUM(${this.ifElse(
                    `m.value >= (s.value_min + s.bin_width*${
                      i + 1
                    }.0) AND m.value < (s.value_min + s.bin_width*${i + 2}.0)`,
                    "1",
                    "0"
                  )}) as units_bin_${i + 1}`
              )
              .join("\n")}
            , SUM(${this.ifElse(
              `m.value >= (s.value_min + s.bin_width*${
                DEFAULT_METRIC_HISTOGRAM_BINS - 1
              }.0)`,
              "1",
              "0"
            )}) as units_bin_${DEFAULT_METRIC_HISTOGRAM_BINS - 1}
          FROM
            __userMetricOverall m
          CROSS JOIN
            __statisticsOverall s
        ) `
            : ""
        }
        SELECT
            *
        FROM __statisticsOverall
        ${createHistogram ? `CROSS JOIN __histogram` : ""}
        UNION ALL
        SELECT
            *
        FROM __statisticsDaily
      `,
      this.getFormatDialect()
    );
  }

  async runMetricAnalysisQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<MetricAnalysisQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);

    function parseUnitsBinData(
      // eslint-disable-next-line
      row: Record<string, any>
    ): Partial<MetricAnalysisQueryResponseRow> {
      const data: Record<string, number> = {};

      for (let i = 0; i < DEFAULT_METRIC_HISTOGRAM_BINS; i++) {
        const key = `units_bin_${i}`;
        const parsed = parseFloat(row[key]);
        if (parsed) {
          data[key] = parsed;
        }
      }

      return data as Partial<MetricAnalysisQueryResponseRow>;
    }

    return {
      rows: rows.map((row) => {
        const {
          date,
          data_type,
          units,
          capped,
          main_sum,
          main_sum_squares,
          denominator_sum,
          denominator_sum_squares,
          main_denominator_sum_product,
          value_min,
          value_max,
        } = row;

        const ret: MetricAnalysisQueryResponseRow = {
          date: date ? getValidDate(date).toISOString() : "",
          data_type: data_type ?? "",
          capped: (capped ?? "uncapped") == "capped",
          units: parseFloat(units) || 0,
          main_sum: parseFloat(main_sum) || 0,
          main_sum_squares: parseFloat(main_sum_squares) || 0,
          denominator_sum: parseFloat(denominator_sum) || 0,
          denominator_sum_squares: parseFloat(denominator_sum_squares) || 0,
          main_denominator_sum_product:
            parseFloat(main_denominator_sum_product) || 0,

          value_min: parseFloat(value_min) || 0,
          value_max: parseFloat(value_max) || 0,
          ...(parseFloat(row.bin_width) && {
            bin_width: parseFloat(row.bin_width),
          }),
          ...parseUnitsBinData(row),
        };
        return ret;
      }),
      statistics: statistics,
    };
  }

  getQuantileBoundsFromQueryResponse(
    // eslint-disable-next-line
    row: Record<string, any>,
    prefix: string
  ) {
    // Finds the lower and upper bounds that correspond to the largest
    // nstar that is smaller than the actual quantile n
    const quantileData: {
      [key: string]: number;
    } = {};
    if (row[`${prefix}quantile`] !== undefined) {
      quantileData[`${prefix}quantile_n`] =
        parseFloat(row[`${prefix}quantile_n`]) || 0;

      const smallestNStar = Math.min(...N_STAR_VALUES);

      // process grid for quantile data
      N_STAR_VALUES.forEach((n) => {
        const lowerColumn = `${prefix}quantile_lower_${n}`;
        const upperColumn = `${prefix}quantile_upper_${n}`;
        if (row[lowerColumn] === undefined || row[upperColumn] === undefined)
          return;

        if (
          // if nstar is smaller, or if it's the smallest nstar, proceed
          (n < quantileData[`${prefix}quantile_n`] || n == smallestNStar) &&
          // if N_STAR_VALUES isn't ascending need to make sure
          // this n is the largest n we've seen so far
          n > (Number(quantileData[`${prefix}quantile_nstar`]) || 0)
        ) {
          quantileData[`${prefix}quantile_lower`] =
            parseFloat(row[lowerColumn]) || 0;
          quantileData[`${prefix}quantile_upper`] =
            parseFloat(row[upperColumn]) || 0;
          quantileData[`${prefix}quantile_nstar`] = n;
        }
      });
    }
    return quantileData;
  }

  async runPopulationFactMetricsQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentFactMetricsQueryResponse> {
    return this.runExperimentFactMetricsQuery(query, setExternalId);
  }
  async runExperimentFactMetricsQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentFactMetricsQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);

    const floatCols = [
      "main_sum",
      "main_sum_squares",
      "main_cap_value",
      "denominator_sum",
      "denominator_sum_squares",
      "main_denominator_sum_product",
      "denominator_cap_value",
      "covariate_sum",
      "covariate_sum_squares",
      "denominator_pre_sum",
      "denominator_pre_sum_squares",
      "main_covariate_sum_product",
      "quantile",
      "theta",
      "main_post_denominator_pre_sum_product",
      "main_pre_denominator_post_sum_product",
      "main_pre_denominator_pre_sum_product",
      "denominator_post_denominator_pre_sum_product",
    ];

    return {
      rows: rows.map((row) => {
        let metricData: {
          [key: string]: number | string;
        } = {};
        for (let i = 0; i < 100; i++) {
          const prefix = `m${i}_`;
          // Reached the end
          if (!row[prefix + "id"]) break;

          metricData[prefix + "id"] = row[prefix + "id"];
          floatCols.forEach((col) => {
            if (row[prefix + col] !== undefined) {
              metricData[prefix + col] = parseFloat(row[prefix + col]) || 0;
            }
          });

          metricData = {
            ...metricData,
            ...this.getQuantileBoundsFromQueryResponse(row, prefix),
          };
        }

        return {
          variation: row.variation ?? "",
          dimension: row.dimension || "",
          users: parseInt(row.users) || 0,
          count: parseInt(row.users) || 0,
          ...metricData,
        };
      }),
      statistics: statistics,
    };
  }
  async runPopulationMetricQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentMetricQueryResponse> {
    return this.runExperimentMetricQuery(query, setExternalId);
  }

  async runExperimentMetricQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentMetricQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);
    return {
      rows: rows.map((row) => {
        return {
          variation: row.variation ?? "",
          dimension: row.dimension || "",
          users: parseInt(row.users) || 0,
          count: parseInt(row.users) || 0,
          main_sum: parseFloat(row.main_sum) || 0,
          main_sum_squares: parseFloat(row.main_sum_squares) || 0,
          ...(row.quantile !== undefined && {
            quantile: parseFloat(row.quantile) || 0,
            ...this.getQuantileBoundsFromQueryResponse(row, ""),
          }),
          ...(row.denominator_sum !== undefined && {
            denominator_sum: parseFloat(row.denominator_sum) || 0,
            denominator_sum_squares:
              parseFloat(row.denominator_sum_squares) || 0,
          }),
          ...(row.main_denominator_sum_product !== undefined && {
            main_denominator_sum_product:
              parseFloat(row.main_denominator_sum_product) || 0,
          }),
          ...(row.covariate_sum !== undefined && {
            covariate_sum: parseFloat(row.covariate_sum) || 0,
            covariate_sum_squares: parseFloat(row.covariate_sum_squares) || 0,
          }),
          ...(row.denominator_pre_sum !== undefined && {
            denominator_pre_sum: parseFloat(row.denominator_pre_sum) || 0,
            denominator_pre_sum_squares:
              parseFloat(row.denominator_pre_sum_squares) || 0,
          }),
          ...(row.main_covariate_sum_product !== undefined && {
            main_covariate_sum_product:
              parseFloat(row.main_covariate_sum_product) || 0,
          }),
          ...(row.main_cap_value !== undefined && {
            main_cap_value: row.main_cap_value,
          }),
          ...(row.denominator_cap_value !== undefined && {
            denominator_cap_value: row.denominator_cap_value,
          }),
          ...(row.theta !== undefined && {
            theta: parseFloat(row.theta) || 0,
          }),
          ...(row.main_covariate_sum_product !== undefined && {
            main_covariate_sum_product:
              parseFloat(row.main_covariate_sum_product) || 0,
          }),
          ...(row.main_post_denominator_pre_sum_product !== undefined && {
            main_post_denominator_pre_sum_product:
              parseFloat(row.main_post_denominator_pre_sum_product) || 0,
          }),
          ...(row.main_pre_denominator_post_sum_product !== undefined && {
            main_pre_denominator_post_sum_product:
              parseFloat(row.main_pre_denominator_post_sum_product) || 0,
          }),
          ...(row.main_pre_denominator_pre_sum_product !== undefined && {
            main_pre_denominator_pre_sum_product:
              parseFloat(row.main_pre_denominator_pre_sum_product) || 0,
          }),
          ...(row.denominator_post_denominator_pre_sum_product !==
            undefined && {
            denominator_post_denominator_pre_sum_product:
              parseFloat(row.denominator_post_denominator_pre_sum_product) || 0,
          }),
          ...(row.main_post_denominator_pre_sum_product !== undefined && {
            main_post_denominator_pre_sum_product:
              parseFloat(row.main_post_denominator_pre_sum_product) || 0,
          }),
        };
      }),
      statistics: statistics,
    };
  }

  async runExperimentAggregateUnitsQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentAggregateUnitsQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);
    return {
      rows: rows.map((row) => {
        return {
          variation: row.variation ?? "",
          units: parseFloat(row.units) || 0,
          dimension_value: row.dimension_value ?? "",
          dimension_name: row.dimension_name ?? "",
        };
      }),
      statistics: statistics,
    };
  }

  async runExperimentUnitsQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<ExperimentUnitsQueryResponse> {
    return await this.runQuery(query, setExternalId);
  }

  async runMetricValueQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<MetricValueQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);

    return {
      rows: rows.map((row) => {
        const { date, count, main_sum, main_sum_squares } = row;

        const ret: MetricValueQueryResponseRow = {
          date: date ? getValidDate(date).toISOString() : "",
          count: parseFloat(count) || 0,
          main_sum: parseFloat(main_sum) || 0,
          main_sum_squares: parseFloat(main_sum_squares) || 0,
        };

        return ret;
      }),
      statistics: statistics,
    };
  }

  //Test the validity of a query as cheaply as possible
  getTestValidityQuery(
    query: string,
    testDays?: number,
    templateVariables?: TemplateVariables
  ): string {
    return this.getTestQuery({
      query,
      templateVariables,
      testDays: testDays ?? DEFAULT_TEST_QUERY_DAYS,
      limit: 1,
    });
  }

  getFreeFormQuery(sql: string, limit?: number): string {
    const limitedQuery = this.ensureMaxLimit(sql, limit ?? SQL_ROW_LIMIT);
    return format(limitedQuery, this.getFormatDialect());
  }

  getTestQuery(params: TestQueryParams): string {
    const { query, templateVariables } = params;
    const limit = params.limit ?? 5;
    const testDays = params.testDays ?? DEFAULT_TEST_QUERY_DAYS;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - testDays);
    const limitedQuery = compileSqlTemplate(
      `WITH __table as (
        ${query}
      )
      ${this.selectStarLimit("__table", limit)}`,
      {
        startDate,
        templateVariables,
      }
    );
    return format(limitedQuery, this.getFormatDialect());
  }

  async runTestQuery(
    sql: string,
    timestampCols?: string[]
  ): Promise<TestQueryResult> {
    // Calculate the run time of the query
    const queryStartTime = Date.now();
    const results = await this.runQuery(sql);
    const queryEndTime = Date.now();
    const duration = queryEndTime - queryStartTime;

    if (timestampCols) {
      results.rows.forEach((row) => {
        timestampCols.forEach((col) => {
          if (row[col]) {
            row[col] = getValidDate(row[col]);
          }
        });
      });
    }

    return { results: results.rows, duration };
  }

  getDropUnitsTableQuery(params: DropTableQueryParams): string {
    // valdidate units table query follows expected name to help
    // prevent dropping other tables
    if (!params.fullTablePath.includes(UNITS_TABLE_PREFIX)) {
      throw new Error(
        "Unable to drop table that is not temporary units table."
      );
    }
    return `DROP TABLE IF EXISTS ${params.fullTablePath}`;
  }
  async runDropTableQuery(
    sql: string,
    setExternalId: ExternalIdCallback
  ): Promise<DropTableQueryResponse> {
    const results = await this.runQuery(sql, setExternalId);
    return results;
  }

  private getIdentitiesCTE({
    objects,
    from,
    to,
    forcedBaseIdType,
    experimentId,
  }: {
    objects: string[][];
    from: Date;
    to?: Date;
    forcedBaseIdType?: string;
    experimentId?: string;
  }) {
    const { baseIdType, joinsRequired } = getBaseIdTypeAndJoins(
      objects,
      forcedBaseIdType
    );

    // Joins for when an object doesn't support the baseIdType
    const joins: string[] = [];
    const idJoinMap: Record<string, string> = {};

    // Generate table names and SQL for each of the required joins
    joinsRequired.forEach((idType) => {
      const table = `__identities_${idType.replace(/[^a-zA-Z0-9_]/g, "")}`;
      idJoinMap[idType] = table;
      joins.push(
        `${table} as (
        ${this.getIdentitiesQuery(
          this.datasource.settings,
          baseIdType,
          idType,
          from,
          to,
          experimentId
        )}
      ),`
      );
    });

    return {
      baseIdType,
      idJoinSQL: joins.join("\n"),
      idJoinMap,
    };
  }

  private getFunnelUsersCTE(
    baseIdType: string,
    metrics: ExperimentMetricInterface[],
    endDate: Date,
    regressionAdjusted: boolean = false,
    cumulativeDate: boolean = false,
    overrideConversionWindows: boolean = false,
    banditDates: Date[] | undefined = undefined,
    tablePrefix: string = "__denominator",
    initialTable: string = "__experiment"
  ) {
    // Note: the aliases below are needed for clickhouse
    return `
      -- one row per user
      SELECT
        initial.${baseIdType} AS ${baseIdType}
        , MIN(initial.dimension) AS dimension
        , MIN(initial.variation) AS variation
        , MIN(initial.first_exposure_date) AS first_exposure_date
        ${
          banditDates?.length
            ? `, MIN(initial.bandit_period) AS bandit_period`
            : ""
        }
        ${
          regressionAdjusted
            ? `
            , MIN(initial.preexposure_start) AS preexposure_start
            , MIN(initial.preexposure_end) AS preexposure_end`
            : ""
        }
        , MIN(t${metrics.length - 1}.timestamp) AS timestamp
      FROM
        ${initialTable} initial
        ${metrics
          .map((m, i) => {
            const prevAlias = i ? `t${i - 1}` : "initial";
            const alias = `t${i}`;
            return `JOIN ${tablePrefix}${i} ${alias} ON (
            ${alias}.${baseIdType} = ${prevAlias}.${baseIdType}
          )`;
          })
          .join("\n")}
      WHERE
        ${metrics
          .map((m, i) => {
            const prevAlias = i ? `t${i - 1}` : "initial";
            const alias = `t${i}`;
            return this.getConversionWindowClause(
              `${prevAlias}.timestamp`,
              `${alias}.timestamp`,
              m,
              endDate,
              cumulativeDate,
              overrideConversionWindows
            );
          })
          .join("\n AND ")}
      GROUP BY
        initial.${baseIdType}`;
  }

  private getDimensionColumn(
    baseIdType: string,
    dimension: UserDimension | ExperimentDimension | null
  ) {
    const missingDimString = "__NULL_DIMENSION";
    if (!dimension) {
      return this.castToString("''");
    } else if (dimension.type === "user") {
      return `COALESCE(MAX(${this.castToString(
        `__dim_unit_${dimension.dimension.id}.value`
      )}),'${missingDimString}')`;
    } else if (dimension.type === "experiment") {
      return `SUBSTRING(
        MIN(
          CONCAT(SUBSTRING(${this.formatDateTimeString("e.timestamp")}, 1, 19), 
            coalesce(${this.castToString(
              `e.dim_${dimension.id}`
            )}, ${this.castToString(`'${missingDimString}'`)})
          )
        ),
        20, 
        99999
      )`;
    }

    throw new Error("Unknown dimension type: " + (dimension as Dimension).type);
  }

  private getConversionWindowClause(
    baseCol: string,
    metricCol: string,
    metric: ExperimentMetricInterface,
    endDate: Date,
    cumulativeDate: boolean,
    overrideConversionWindows: boolean
  ): string {
    let windowHours = getConversionWindowHours(metric.windowSettings);
    const delayHours = getDelayWindowHours(metric.windowSettings);

    // all metrics have to be after the base timestamp +- delay hours
    let metricWindow = `${metricCol} >= ${this.addHours(baseCol, delayHours)}`;

    if (
      metric.windowSettings.type === "conversion" &&
      !overrideConversionWindows
    ) {
      // if conversion window, then count metrics before window ends
      // which can extend beyond experiment end date
      metricWindow = `${metricWindow}
        AND ${metricCol} <= ${this.addHours(
        baseCol,
        delayHours + windowHours
      )}`;
    } else {
      // otherwise, it must be before the experiment end date
      metricWindow = `${metricWindow}
      AND ${metricCol} <= ${this.toTimestamp(endDate)}`;
    }

    if (metric.windowSettings.type === "lookback") {
      // ensure windowHours is positive
      windowHours = windowHours < 0 ? windowHours * -1 : windowHours;
      // also ensure for lookback windows that metric happened in last
      // X hours of the experiment
      metricWindow = `${metricWindow}
      AND ${this.addHours(metricCol, windowHours)} >= 
      ${cumulativeDate ? "dr.day" : this.toTimestamp(endDate)}`;
    }

    return metricWindow;
  }

  private getMetricMinDelay(metrics: ExperimentMetricInterface[]) {
    let runningDelay = 0;
    let minDelay = 0;
    metrics.forEach((m) => {
      if (getDelayWindowHours(m.windowSettings)) {
        const delay = runningDelay + getDelayWindowHours(m.windowSettings);
        if (delay < minDelay) minDelay = delay;
        runningDelay = delay;
      }
    });
    return minDelay;
  }

  private getMetricStart(
    initial: Date,
    minDelay: number,
    regressionAdjustmentHours: number
  ) {
    const metricStart = new Date(initial);
    if (minDelay < 0) {
      metricStart.setHours(metricStart.getHours() + minDelay);
    }
    if (regressionAdjustmentHours > 0) {
      metricStart.setHours(metricStart.getHours() - regressionAdjustmentHours);
    }
    return metricStart;
  }

  private getMetricEnd(
    metrics: ExperimentMetricInterface[],
    initial?: Date,
    overrideConversionWindows?: boolean
  ): Date | null {
    if (!initial) return null;
    if (overrideConversionWindows) return initial;

    const metricEnd = new Date(initial);
    let runningHours = 0;
    let maxHours = 0;
    metrics.forEach((m) => {
      if (m.windowSettings.type === "conversion") {
        const hours =
          runningHours +
          getConversionWindowHours(m.windowSettings) +
          getDelayWindowHours(m.windowSettings);
        if (hours > maxHours) maxHours = hours;
        runningHours = hours;
      }
    });

    if (maxHours > 0) {
      metricEnd.setHours(metricEnd.getHours() + maxHours);
    }

    return metricEnd;
  }

  private getMaxHoursToConvert(
    funnelMetric: boolean,
    metricAndDenominatorMetrics: ExperimentMetricInterface[],
    activationMetric: ExperimentMetricInterface | null
  ): number {
    // Used to set an experiment end date to filter out users
    // who have not had enough time to convert (if experimenter
    // has selected `skipPartialData`)
    let neededHoursForConversion = 0;
    metricAndDenominatorMetrics.forEach((m) => {
      if (m.windowSettings.type === "conversion") {
        const metricHours =
          getDelayWindowHours(m.windowSettings) +
          getConversionWindowHours(m.windowSettings);
        if (funnelMetric) {
          // funnel metric windows can cascade, so sum each metric hours to get max
          neededHoursForConversion += metricHours;
        } else if (metricHours > neededHoursForConversion) {
          neededHoursForConversion = metricHours;
        }
      }
    });
    // activation metrics windows always cascade
    if (
      activationMetric &&
      activationMetric.windowSettings.type == "conversion"
    ) {
      neededHoursForConversion +=
        getDelayWindowHours(activationMetric.windowSettings) +
        getConversionWindowHours(activationMetric.windowSettings);
    }
    return neededHoursForConversion;
  }

  processDimensions(
    dimensions: Dimension[],
    settings: ExperimentSnapshotSettings,
    activationMetric: ExperimentMetricInterface | null
  ): ProcessedDimensions {
    const processedDimensions: ProcessedDimensions = {
      unitDimensions: [],
      experimentDimensions: [],
      activationDimension: null,
    };
    dimensions.forEach((dimension) => {
      if (dimension?.type === "activation") {
        if (activationMetric) {
          processedDimensions.activationDimension = { type: "activation" };
        }
      } else if (dimension?.type === "user") {
        // Replace any placeholders in the user defined dimension SQL
        const clonedDimension = cloneDeep<UserDimension>(dimension);
        clonedDimension.dimension.sql = compileSqlTemplate(
          dimension.dimension.sql,
          {
            startDate: settings.startDate,
            endDate: settings.endDate,
            experimentId: settings.experimentId,
          }
        );
        processedDimensions.unitDimensions.push(clonedDimension);
      } else if (dimension?.type === "experiment") {
        processedDimensions.experimentDimensions.push(dimension);
      }
    });
    return processedDimensions;
  }

  createUnitsTableOptions() {
    return "";
  }

  getExperimentUnitsTableQuery(params: ExperimentUnitsQueryParams): string {
    return format(
      `
    CREATE OR REPLACE TABLE ${params.unitsTableFullName}
    ${this.createUnitsTableOptions()}
    AS (
      WITH
        ${this.getExperimentUnitsQuery(params)}
      SELECT * FROM __experimentUnits
    );
    `,
      this.getFormatDialect()
    );
  }

  processActivationMetric(
    activationMetricDoc: null | ExperimentMetricInterface,
    settings: ExperimentSnapshotSettings
  ): null | ExperimentMetricInterface {
    let activationMetric: null | ExperimentMetricInterface = null;
    if (activationMetricDoc) {
      activationMetric = cloneDeep<ExperimentMetricInterface>(
        activationMetricDoc
      );
      applyMetricOverrides(activationMetric, settings);
    }
    return activationMetric;
  }

  getDimensionInStatement(dimension: string, values: string[]): string {
    return this.ifElse(
      `${this.castToString(dimension)} IN (${values
        .map((v) => `'` + this.escapeStringLiteral(v) + `'`)
        .join(",")})`,
      this.castToString(dimension),
      this.castToString(`'${AUTOMATIC_DIMENSION_OTHER_NAME}'`)
    );
  }

  getPopulationMetricQuery(params: PopulationMetricQueryParams): string {
    const { factTableMap, segment, populationSettings } = params;
    // dimension date?
    const populationSQL = this.getPowerPopulationCTEs({
      settings: populationSettings,
      factTableMap,
      segment,
    });

    return this.getExperimentMetricQuery({
      ...params,
      unitsSource: "otherQuery",
      unitsSql: populationSQL,
      forcedUserIdType: params.populationSettings.userIdType,
    });
  }

  getPopulationFactMetricsQuery(
    params: PopulationFactMetricsQueryParams
  ): string {
    const { factTableMap, segment, populationSettings } = params;

    const populationSQL = this.getPowerPopulationCTEs({
      settings: populationSettings,
      factTableMap,
      segment,
    });
    return this.getExperimentFactMetricsQuery({
      ...params,
      unitsSource: "otherQuery",
      unitsSql: populationSQL,
      forcedUserIdType: params.populationSettings.userIdType,
    });
  }

  getExperimentUnitsQuery(params: ExperimentUnitsQueryParams): string {
    const {
      settings,
      segment,
      activationMetric: activationMetricDoc,
      factTableMap,
    } = params;

    const activationMetric = this.processActivationMetric(
      activationMetricDoc,
      settings
    );

    const { experimentDimensions, unitDimensions } = this.processDimensions(
      params.dimensions,
      settings,
      activationMetric
    );

    const exposureQuery = this.getExposureQuery(settings.exposureQueryId || "");

    // Get any required identity join queries
    const { baseIdType, idJoinMap, idJoinSQL } = this.getIdentitiesCTE({
      objects: [
        [exposureQuery.userIdType],
        activationMetric ? getUserIdTypes(activationMetric, factTableMap) : [],
        ...unitDimensions.map((d) => [d.dimension.userIdType || "user_id"]),
        segment ? [segment.userIdType || "user_id"] : [],
      ],
      from: settings.startDate,
      to: settings.endDate,
      forcedBaseIdType: exposureQuery.userIdType,
      experimentId: settings.experimentId,
    });

    // Get date range for experiment
    const startDate: Date = settings.startDate;
    const endDate: Date = this.getExperimentEndDate(settings, 0);

    const timestampColumn = "e.timestamp";
    // BQ datetime cast for SELECT statements (do not use for where)
    const timestampDateTimeColumn = this.castUserDateCol(timestampColumn);
    const overrideConversionWindows =
      settings.attributionModel === "experimentDuration";

    return `
    ${params.includeIdJoins ? idJoinSQL : ""}
    __rawExperiment AS (
      ${compileSqlTemplate(exposureQuery.query, {
        startDate: settings.startDate,
        endDate: settings.endDate,
        experimentId: settings.experimentId,
      })}
    ),
    __experimentExposures AS (
      -- Viewed Experiment
      SELECT
        e.${baseIdType} as ${baseIdType}
        , ${this.castToString("e.variation_id")} as variation
        , ${timestampDateTimeColumn} as timestamp
        ${experimentDimensions
          .map((d) => {
            if (d.specifiedSlices?.length) {
              return `, ${this.getDimensionInStatement(
                d.id,
                d.specifiedSlices
              )} AS dim_${d.id}`;
            }
            return `, e.${d.id} AS dim_${d.id}`;
          })
          .join("\n")}
      FROM
          __rawExperiment e
      WHERE
          e.experiment_id = '${settings.experimentId}'
          AND ${timestampColumn} >= ${this.toTimestamp(startDate)}
          ${
            endDate
              ? `AND ${timestampColumn} <= ${this.toTimestamp(endDate)}`
              : ""
          }
          ${settings.queryFilter ? `AND (\n${settings.queryFilter}\n)` : ""}
    )
    ${
      activationMetric
        ? `, __activationMetric as (${this.getMetricCTE({
            metric: activationMetric,
            baseIdType,
            idJoinMap,
            startDate: this.getMetricStart(
              settings.startDate,
              getDelayWindowHours(activationMetric.windowSettings),
              0
            ),
            endDate: this.getMetricEnd(
              [activationMetric],
              settings.endDate,
              overrideConversionWindows
            ),
            experimentId: settings.experimentId,
            factTableMap,
          })})
        `
        : ""
    }
    ${
      segment
        ? `, __segment as (${this.getSegmentCTE(
            segment,
            baseIdType,
            idJoinMap,
            factTableMap,
            {
              startDate: settings.startDate,
              endDate: settings.endDate,
              experimentId: settings.experimentId,
            }
          )})`
        : ""
    }
    ${unitDimensions
      .map(
        (d) =>
          `, __dim_unit_${d.dimension.id} as (${this.getDimensionCTE(
            d.dimension,
            baseIdType,
            idJoinMap
          )})`
      )
      .join("\n")}
    , __experimentUnits AS (
      -- One row per user
      SELECT
        e.${baseIdType} AS ${baseIdType}
        , ${this.ifElse(
          "count(distinct e.variation) > 1",
          "'__multiple__'",
          "max(e.variation)"
        )} AS variation
        , MIN(${timestampColumn}) AS first_exposure_timestamp
        ${unitDimensions
          .map(
            (d) => `
          , ${this.getDimensionColumn(baseIdType, d)} AS dim_unit_${
              d.dimension.id
            }`
          )
          .join("\n")}
        ${experimentDimensions
          .map(
            (d) => `
          , ${this.getDimensionColumn(baseIdType, d)} AS dim_exp_${d.id}`
          )
          .join("\n")}
        ${
          activationMetric
            ? `, MIN(${this.ifElse(
                this.getConversionWindowClause(
                  "e.timestamp",
                  "a.timestamp",
                  activationMetric,
                  settings.endDate,
                  false,
                  overrideConversionWindows
                ),
                "a.timestamp",
                "NULL"
              )}) AS first_activation_timestamp
            `
            : ""
        }
      FROM
        __experimentExposures e
        ${
          segment
            ? `JOIN __segment s ON (s.${baseIdType} = e.${baseIdType})`
            : ""
        }
        ${unitDimensions
          .map(
            (d) => `
            LEFT JOIN __dim_unit_${d.dimension.id} __dim_unit_${d.dimension.id} ON (
              __dim_unit_${d.dimension.id}.${baseIdType} = e.${baseIdType}
            )
          `
          )
          .join("\n")}
        ${
          activationMetric
            ? `LEFT JOIN __activationMetric a ON (a.${baseIdType} = e.${baseIdType})`
            : ""
        }
      ${segment ? `WHERE s.date <= e.timestamp` : ""}
      GROUP BY
        e.${baseIdType}
    )`;
  }

  getBanditVariationPeriodWeights(
    banditSettings: SnapshotBanditSettings,
    variations: SnapshotSettingsVariation[]
  ): VariationPeriodWeight[] | undefined {
    let anyMissingValues = false;
    const variationPeriodWeights = banditSettings.historicalWeights
      .map((w) => {
        return w.weights.map((weight, index) => {
          const variationId = variations?.[index]?.id;
          if (!variationId) {
            anyMissingValues = true;
          }
          return { weight, variationId: variationId, date: w.date };
        });
      })
      .flat();

    if (anyMissingValues) {
      return undefined;
    }

    return variationPeriodWeights;
  }

  getExperimentAggregateUnitsQuery(
    params: ExperimentAggregateUnitsQueryParams
  ): string {
    const {
      activationMetric,
      segment,
      settings,
      factTableMap,
      useUnitsTable,
    } = params;

    // unitDimensions not supported yet
    const { experimentDimensions } = this.processDimensions(
      params.dimensions,
      settings,
      activationMetric
    );

    const exposureQuery = this.getExposureQuery(settings.exposureQueryId || "");

    // get bandit data for SRM calculation
    const banditDates = settings.banditSettings?.historicalWeights.map(
      (w) => w.date
    );
    const variationPeriodWeights = settings.banditSettings
      ? this.getBanditVariationPeriodWeights(
          settings.banditSettings,
          settings.variations
        )
      : undefined;

    const computeBanditSrm = !!banditDates && !!variationPeriodWeights;

    // Get any required identity join queries
    const { baseIdType, idJoinSQL } = this.getIdentitiesCTE({
      // add idTypes usually handled in units query here in the case where
      // we don't have a separate table for the units query
      // then for this query we just need the activation metric for activation
      // dimensions
      objects: [
        [exposureQuery.userIdType],
        !useUnitsTable && activationMetric
          ? getUserIdTypes(activationMetric, factTableMap)
          : [],
        !useUnitsTable && segment ? [segment.userIdType || "user_id"] : [],
      ],
      from: settings.startDate,
      to: settings.endDate,
      forcedBaseIdType: exposureQuery.userIdType,
      experimentId: settings.experimentId,
    });

    return format(
      `-- Traffic Query for Health Tab
    WITH
      ${idJoinSQL}
      ${
        !useUnitsTable
          ? `${this.getExperimentUnitsQuery({
              ...params,
              includeIdJoins: false,
            })},`
          : ""
      }
      __distinctUnits AS (
        SELECT
          ${baseIdType}
          , variation
          , ${this.formatDate(
            this.dateTrunc("first_exposure_timestamp")
          )} AS dim_exposure_date
          ${banditDates ? `${this.getBanditCaseWhen(banditDates)}` : ""}
          ${experimentDimensions.map((d) => `, dim_exp_${d.id}`).join("\n")}
          ${
            activationMetric
              ? `, ${this.ifElse(
                  `first_activation_timestamp IS NULL`,
                  "'Not Activated'",
                  "'Activated'"
                )} AS dim_activated`
              : ""
          }
        FROM ${
          useUnitsTable ? `${params.unitsTableFullName}` : "__experimentUnits"
        }
      )
      , __unitsByDimension AS (
        -- One row per variation per dimension slice
        ${[
          "dim_exposure_date",
          ...experimentDimensions.map((d) => `dim_exp_${d.id}`),
          ...(activationMetric ? ["dim_activated"] : []),
        ]
          .map((d) =>
            this.getUnitCountCTE(
              d,
              activationMetric && d !== "dim_activated"
                ? "WHERE dim_activated = 'Activated'"
                : "",
              // cast to float to union with bandit test statistic which is float
              computeBanditSrm
            )
          )
          .join("\nUNION ALL\n")}
      )
      ${
        computeBanditSrm
          ? `
        , variationBanditPeriodWeights AS (
          ${variationPeriodWeights
            .map(
              (w) => `
            SELECT
              ${this.castToString(`'${w.variationId}'`)} AS variation
              , ${this.toTimestamp(w.date)} AS bandit_period
              , ${w.weight} AS weight
          `
            )
            .join("\nUNION ALL\n")}
        )
        , __unitsByVariationBanditPeriod AS (
          SELECT
            v.variation AS variation
            , v.bandit_period AS bandit_period
            , v.weight AS weight
            , COALESCE(COUNT(d.bandit_period), 0) AS units
          FROM variationBanditPeriodWeights v
          LEFT JOIN __distinctUnits d
            ON (d.variation = v.variation AND d.bandit_period = v.bandit_period)
          GROUP BY
            v.variation
            , v.bandit_period
            , v.weight
        )
        , __totalUnitsByBanditPeriod AS (
          SELECT
            bandit_period
            , SUM(units) AS total_units
          FROM __unitsByVariationBanditPeriod
          GROUP BY
            bandit_period
        )
        , __expectedUnitsByVariationBanditPeriod AS (
          SELECT
            u.variation AS variation
            , MAX(${this.castToString("''")}) AS constant
            , SUM(u.units) AS units
            , SUM(t.total_units * u.weight) AS expected_units
          FROM __unitsByVariationBanditPeriod u
          LEFT JOIN __totalUnitsByBanditPeriod t
            ON (t.bandit_period = u.bandit_period)
          WHERE
            COALESCE(t.total_units, 0) > 0
          GROUP BY
            u.variation
        )
        , __banditSrm AS (
          SELECT
            MAX(${this.castToString("''")}) AS variation
            , MAX(${this.castToString("''")}) AS dimension_value
            , MAX(${this.castToString(
              `'${BANDIT_SRM_DIMENSION_NAME}'`
            )}) AS dimension_name
            , SUM(POW(expected_units - units, 2) / expected_units) AS units
          FROM __expectedUnitsByVariationBanditPeriod
          GROUP BY
            constant
        ),
        __unitsByDimensionWithBanditSrm AS (
          SELECT
            *
          FROM __unitsByDimension
          UNION ALL
          SELECT
            *
          FROM __banditSrm
        )
      `
          : ""
      }

      ${this.selectStarLimit(
        computeBanditSrm
          ? "__unitsByDimensionWithBanditSrm"
          : "__unitsByDimension",
        MAX_ROWS_UNIT_AGGREGATE_QUERY
      )}
    `,
      this.getFormatDialect()
    );
  }

  getUnitCountCTE(
    dimensionColumn: string,
    whereClause?: string,
    ensureFloat?: boolean
  ): string {
    return ` -- ${dimensionColumn}
    SELECT
      variation AS variation
      , ${dimensionColumn} AS dimension_value
      , MAX(${this.castToString(`'${dimensionColumn}'`)}) AS dimension_name
      , ${ensureFloat ? this.ensureFloat("COUNT(*)") : "COUNT(*)"} AS units
    FROM
      __distinctUnits
    ${whereClause ?? ""}
    GROUP BY
      variation
      , ${dimensionColumn}`;
  }

  getDimensionSlicesQuery(params: DimensionSlicesQueryParams): string {
    const exposureQuery = this.getExposureQuery(params.exposureQueryId || "");

    const { baseIdType } = getBaseIdTypeAndJoins([[exposureQuery.userIdType]]);

    const startDate = subDays(new Date(), params.lookbackDays);
    const timestampColumn = "e.timestamp";
    return format(
      `-- Dimension Traffic Query
    WITH
      __rawExperiment AS (
        ${compileSqlTemplate(exposureQuery.query, {
          startDate: startDate,
        })}
      ),
      __experimentExposures AS (
        -- Viewed Experiment
        SELECT
          e.${baseIdType} as ${baseIdType}
          , e.timestamp
          ${params.dimensions
            .map((d) => `, e.${d.id} AS dim_${d.id}`)
            .join("\n")}
        FROM
          __rawExperiment e
        WHERE
          ${timestampColumn} >= ${this.toTimestamp(startDate)}
      ),
      __distinctUnits AS (
        SELECT
          ${baseIdType}
          ${params.dimensions
            .map(
              (d) => `
            , ${this.getDimensionColumn(baseIdType, d)} AS dim_exp_${d.id}`
            )
            .join("\n")}
          , 1 AS variation
        FROM
          __experimentExposures e
        GROUP BY
          e.${baseIdType}
      ),
      -- One row per dimension slice
      dim_values AS (
        SELECT
          1 AS variation
          , ${this.castToString("''")} AS dimension_value
          , ${this.castToString("''")} AS dimension_name
          , COUNT(*) AS units
        FROM
          __distinctUnits
        UNION ALL
        ${params.dimensions
          .map((d) => this.getUnitCountCTE(`dim_exp_${d.id}`))
          .join("\nUNION ALL\n")}
      ),
      total_n AS (
        SELECT
          SUM(units) AS N
        FROM dim_values
        WHERE dimension_name = ''
      ),
      dim_values_sorted AS (
        SELECT
          dimension_name
          , dimension_value
          , units
          , ROW_NUMBER() OVER (PARTITION BY dimension_name ORDER BY units DESC) as rn
        FROM
          dim_values
        WHERE
          dimension_name != ''
      )
      SELECT
        dim_values_sorted.dimension_name AS dimension_name,
        dim_values_sorted.dimension_value AS dimension_value,
        dim_values_sorted.units AS units,
        n.N AS total_units
      FROM
        dim_values_sorted
      CROSS JOIN total_n n
      WHERE 
        rn <= 20
    `,
      this.getFormatDialect()
    );
  }

  async runDimensionSlicesQuery(
    query: string,
    setExternalId: ExternalIdCallback
  ): Promise<DimensionSlicesQueryResponse> {
    const { rows, statistics } = await this.runQuery(query, setExternalId);
    return {
      rows: rows.map((row) => {
        return {
          dimension_value: row.dimension_value ?? "",
          dimension_name: row.dimension_name ?? "",
          units: parseInt(row.units) || 0,
          total_units: parseInt(row.total_units) || 0,
        };
      }),
      statistics: statistics,
    };
  }

  private getMetricData(
    metric: ExperimentMetricInterface,
    settings: Pick<
      ExperimentSnapshotSettings,
      "attributionModel" | "regressionAdjustmentEnabled" | "startDate"
    > & { endDate?: Date },
    activationMetric: ExperimentMetricInterface | null,
    alias: string
  ): FactMetricData {
    const ratioMetric = isRatioMetric(metric);
    const funnelMetric = isFunnelMetric(metric);
    const quantileMetric = quantileMetricType(metric);
    const metricQuantileSettings: MetricQuantileSettings = (isFactMetric(
      metric
    ) && !!quantileMetric
      ? metric.quantileSettings
      : undefined) ?? { type: "unit", quantile: 0, ignoreZeros: false };

    // redundant checks to make sure configuration makes sense and we only build expensive queries for the cases
    // where RA is actually possible
    const regressionAdjusted =
      settings.regressionAdjustmentEnabled && isRegressionAdjusted(metric);
    const regressionAdjustmentHours = regressionAdjusted
      ? (metric.regressionAdjustmentDays ?? 0) * 24
      : 0;

    const overrideConversionWindows =
      settings.attributionModel === "experimentDuration";

    // Get capping settings and final coalesce statement
    const isPercentileCapped =
      metric.cappingSettings.type === "percentile" &&
      !!metric.cappingSettings.value &&
      metric.cappingSettings.value < 1 &&
      !quantileMetric;
    const capCoalesceMetric = this.capCoalesceValue({
      valueCol: `m.${alias}_value`,
      metric,
      capTablePrefix: "cap",
      capValueCol: `${alias}_value_cap`,
      columnRef: isFactMetric(metric) ? metric.numerator : null,
    });
    const capCoalesceDenominator = this.capCoalesceValue({
      valueCol: `m.${alias}_denominator`,
      metric,
      capTablePrefix: "cap",
      capValueCol: `${alias}_denominator_cap`,
      columnRef: isFactMetric(metric) ? metric.denominator : null,
    });
    const capCoalesceCovariate = this.capCoalesceValue({
      valueCol: `c.${alias}_value`,
      metric,
      capTablePrefix: "cap",
      capValueCol: `${alias}_value_cap`,
      columnRef: isFactMetric(metric) ? metric.numerator : null,
    });
    const capCoalesceDenominatorCovariate = this.capCoalesceValue({
      valueCol: `c.${alias}_denominator`,
      metric,
      capTablePrefix: "cap",
      capValueCol: `${alias}_denominator_cap`,
      columnRef: isFactMetric(metric) ? metric.denominator : null,
    });
    // Get rough date filter for metrics to improve performance
    const orderedMetrics = (activationMetric ? [activationMetric] : []).concat([
      metric,
    ]);
    const minMetricDelay = this.getMetricMinDelay(orderedMetrics);
    const metricStart = this.getMetricStart(
      settings.startDate,
      minMetricDelay,
      regressionAdjustmentHours
    );
    const metricEnd = this.getMetricEnd(
      orderedMetrics,
      settings.endDate,
      overrideConversionWindows
    );

    const raMetricSettings = {
      hours: regressionAdjustmentHours,
      minDelay: minMetricDelay,
      alias,
    };

    const maxHoursToConvert = this.getMaxHoursToConvert(
      funnelMetric,
      [metric],
      activationMetric
    );
    return {
      alias,
      id: metric.id,
      metric,
      ratioMetric,
      funnelMetric,
      quantileMetric,
      metricQuantileSettings,
      regressionAdjusted,
      regressionAdjustmentHours,
      overrideConversionWindows,
      isPercentileCapped,
      capCoalesceMetric,
      capCoalesceDenominator,
      capCoalesceCovariate,
      capCoalesceDenominatorCovariate,
      minMetricDelay,
      raMetricSettings,
      metricStart,
      metricEnd,
      maxHoursToConvert,
    };
  }

  getFactMetricQuantileData(
    metricData: FactMetricData[],
    quantileType: MetricQuantileSettings["type"]
  ) {
    const quantileData: {
      alias: string;
      valueCol: string;
      outputCol: string;
      metricQuantileSettings: MetricQuantileSettings;
    }[] = [];
    metricData
      .filter((m) => m.quantileMetric === quantileType)
      .forEach((m) => {
        quantileData.push({
          alias: m.alias,
          valueCol: `${m.alias}_value`,
          outputCol: `${m.alias}_value_quantile`,
          metricQuantileSettings: m.metricQuantileSettings,
        });
      });
    return quantileData;
  }

  getBanditCaseWhen(periods: Date[]) {
    return `
        , CASE
          ${periods
            .sort((a, b) => b.getTime() - a.getTime())
            .map((p) => {
              return `WHEN first_exposure_timestamp >= ${this.toTimestamp(
                p
              )} THEN ${this.toTimestamp(p)}`;
            })
            .join("\n")}
        END AS bandit_period`;
  }

  getExperimentFactMetricsQuery(
    params: ExperimentFactMetricsQueryParams
  ): string {
    const { settings, segment } = params;
    const metrics = cloneDeep(params.metrics);
    const activationMetric = this.processActivationMetric(
      params.activationMetric,
      settings
    );

    metrics.forEach((m) => {
      applyMetricOverrides(m, settings);
    });
    // Replace any placeholders in the user defined dimension SQL
    const { unitDimensions } = this.processDimensions(
      params.dimensions,
      settings,
      activationMetric
    );

    const factTableMap = params.factTableMap;
    const factTable = factTableMap.get(metrics[0].numerator?.factTableId);
    if (!factTable) {
      throw new Error("Could not find fact table");
    }
    const userIdType =
      params.forcedUserIdType ??
      this.getExposureQuery(settings.exposureQueryId || "").userIdType;
    const metricData = metrics.map((metric, i) =>
      this.getMetricData(metric, settings, activationMetric, `m${i}`)
    );
    const raMetricSettings = metricData
      .filter((m) => m.regressionAdjusted)
      .map((m) => m.raMetricSettings);
    const maxHoursToConvert = Math.max(
      ...metricData.map((m) => m.maxHoursToConvert)
    );
    const metricStart = metricData.reduce(
      (min, d) => (d.metricStart < min ? d.metricStart : min),
      settings.startDate
    );
    const metricEnd = metricData.reduce(
      (max, d) => (d.metricEnd && d.metricEnd > max ? d.metricEnd : max),
      settings.endDate
    );

    // Get any required identity join queries
    const idTypeObjects = [[userIdType], factTable.userIdTypes || []];
    // add idTypes usually handled in units query here in the case where
    // we don't have a separate table for the units query
    if (params.unitsSource === "exposureQuery") {
      idTypeObjects.push(
        ...unitDimensions.map((d) => [d.dimension.userIdType || "user_id"]),
        segment ? [segment.userIdType || "user_id"] : [],
        activationMetric ? getUserIdTypes(activationMetric, factTableMap) : []
      );
    }
    const { baseIdType, idJoinMap, idJoinSQL } = this.getIdentitiesCTE({
      objects: idTypeObjects,
      from: settings.startDate,
      to: settings.endDate,
      forcedBaseIdType: userIdType,
      experimentId: settings.experimentId,
    });

    // Get date range for experiment and analysis
    const startDate: Date = settings.startDate;
    const endDate: Date = this.getExperimentEndDate(
      settings,
      maxHoursToConvert
    );

    if (params.dimensions.length > 1) {
      throw new Error(
        "Multiple dimensions not supported in metric analysis yet. Please contact GrowthBook."
      );
    }
    const dimension = params.dimensions[0];
    let dimensionCol = this.castToString("''");
    if (dimension?.type === "experiment") {
      dimensionCol = `dim_exp_${dimension.id}`;
    } else if (dimension?.type === "user") {
      dimensionCol = `dim_unit_${dimension.dimension.id}`;
    } else if (dimension?.type === "date") {
      dimensionCol = `${this.formatDate(
        this.dateTrunc("first_exposure_timestamp")
      )}`;
    } else if (dimension?.type === "activation") {
      dimensionCol = this.ifElse(
        `first_activation_timestamp IS NULL`,
        "'Not Activated'",
        "'Activated'"
      );
    }

    const timestampColumn =
      activationMetric && dimension?.type !== "activation"
        ? "first_activation_timestamp"
        : "first_exposure_timestamp";

    const distinctUsersWhere: string[] = [];
    if (activationMetric && dimension?.type !== "activation") {
      distinctUsersWhere.push("first_activation_timestamp IS NOT NULL");
    }
    if (settings.skipPartialData) {
      distinctUsersWhere.push(
        `${timestampColumn} <= ${this.toTimestamp(endDate)}`
      );
    }

    const cumulativeDate = false; // TODO enable flag for time series
    const banditDates = settings.banditSettings?.historicalWeights.map(
      (w) => w.date
    );

    const percentileData: {
      valueCol: string;
      outputCol: string;
      percentile: number;
      ignoreZeros: boolean;
    }[] = [];
    metricData
      .filter((m) => m.isPercentileCapped)
      .forEach((m) => {
        percentileData.push({
          valueCol: `${m.alias}_value`,
          outputCol: `${m.alias}_value_cap`,
          percentile: m.metric.cappingSettings.value ?? 1,
          ignoreZeros: m.metric.cappingSettings.ignoreZeros ?? false,
        });
        if (m.ratioMetric) {
          percentileData.push({
            valueCol: `${m.alias}_denominator`,
            outputCol: `${m.alias}_denominator_cap`,
            percentile: m.metric.cappingSettings.value ?? 1,
            ignoreZeros: m.metric.cappingSettings.ignoreZeros ?? false,
          });
        }
      });

    const eventQuantileData = this.getFactMetricQuantileData(
      metricData,
      "event"
    );

    const regressionAdjustedMetrics = metricData.filter(
      (m) => m.regressionAdjusted
    );

    return format(
      `-- Fact Table: ${factTable.name}
    WITH
      ${idJoinSQL}
      ${
        params.unitsSource === "exposureQuery"
          ? `${this.getExperimentUnitsQuery({
              ...params,
              includeIdJoins: false,
            })},`
          : params.unitsSource === "otherQuery"
          ? params.unitsSql
          : ""
      }
      __distinctUsers AS (
        SELECT
          ${baseIdType},
          ${dimensionCol} AS dimension,
          variation,
          ${timestampColumn} AS timestamp,
          ${this.dateTrunc("first_exposure_timestamp")} AS first_exposure_date
          ${banditDates?.length ? this.getBanditCaseWhen(banditDates) : ""}
          ${
            raMetricSettings.length > 0
              ? `
              , ${this.addHours(
                "first_exposure_timestamp",
                Math.min(...raMetricSettings.map((s) => s.minDelay - s.hours))
              )} as min_preexposure_start
              , ${this.addHours(
                "first_exposure_timestamp",
                Math.max(...raMetricSettings.map((s) => s.minDelay))
              )} as max_preexposure_end
            `
              : ""
          }
      ${raMetricSettings
        .map(
          ({ alias, hours, minDelay }) => `
              , ${this.addHours(
                "first_exposure_timestamp",
                minDelay
              )} AS ${alias}_preexposure_end
              , ${this.addHours(
                "first_exposure_timestamp",
                minDelay - hours
              )} AS ${alias}_preexposure_start`
        )
        .join("\n")}
        FROM ${
          params.unitsSource === "exposureTable"
            ? `${params.unitsTableFullName}`
            : "__experimentUnits"
        }
        ${
          distinctUsersWhere.length
            ? `WHERE ${distinctUsersWhere.join(" AND ")}`
            : ""
        }
      )
      , __factTable as (${this.getFactMetricCTE({
        baseIdType,
        idJoinMap,
        metrics,
        endDate: metricEnd,
        startDate: metricStart,
        factTableMap,
        experimentId: settings.experimentId,
      })})
      ${
        cumulativeDate
          ? `, __dateRange AS (
        ${this.getDateTable(
          dateStringArrayBetweenDates(startDate, endDate || new Date())
        )}
      )`
          : ""
      }
      , __userMetricJoin as (
        SELECT
          d.variation AS variation,
          d.dimension AS dimension,
          ${banditDates?.length ? `d.bandit_period AS bandit_period,` : ""}
          ${cumulativeDate ? `dr.day AS day,` : ""}
          d.${baseIdType} AS ${baseIdType},
          ${metricData
            .map(
              (data) =>
                `${this.addCaseWhenTimeFilter(
                  `m.${data.alias}_value`,
                  data.metric,
                  data.overrideConversionWindows,
                  settings.endDate,
                  cumulativeDate,
                  data.quantileMetric ? data.metricQuantileSettings : undefined
                )} as ${data.alias}_value
                ${
                  data.ratioMetric
                    ? `, ${this.addCaseWhenTimeFilter(
                        `m.${data.alias}_denominator`,
                        data.metric,
                        data.overrideConversionWindows,
                        settings.endDate,
                        cumulativeDate
                      )} as ${data.alias}_denominator`
                    : ""
                }
                `
            )
            .join(",")}
          
        FROM
          __distinctUsers d
        LEFT JOIN __factTable m ON (
          m.${baseIdType} = d.${baseIdType}
        )
        ${
          cumulativeDate
            ? `
            CROSS JOIN __dateRange dr
            WHERE d.first_exposure_date <= dr.day
          `
            : ""
        }
      )
      ${
        eventQuantileData.length
          ? `
        , __eventQuantileMetric AS (
          SELECT
          m.variation
          , m.dimension
          ${eventQuantileData
            .map((data) =>
              this.getQuantileGridColumns(
                data.metricQuantileSettings,
                `${data.alias}_`
              )
            )
            .join("\n")}
        FROM
          __userMetricJoin m
        GROUP BY
          m.variation
          , m.dimension
        )`
          : ""
      }
      , __userMetricAgg as (
        -- Add in the aggregate metric value for each user
        SELECT
          umj.variation,
          umj.dimension,
          ${banditDates?.length ? `umj.bandit_period AS bandit_period,` : ""}
          ${cumulativeDate ? "umj.day," : ""}
          umj.${baseIdType},
          ${metricData
            .map(
              (data) =>
                `${this.getAggregateMetricColumn({
                  metric: data.metric,
                  useDenominator: false,
                  valueColumn: `umj.${data.alias}_value`,
                  quantileColumn: `qm.${data.alias}_quantile`,
                })} AS ${data.alias}_value
                ${
                  data.ratioMetric
                    ? `, ${this.getAggregateMetricColumn({
                        metric: data.metric,
                        useDenominator: true,
                        valueColumn: `umj.${data.alias}_denominator`,
                        quantileColumn: `qm.${data.alias}_quantile`,
                      })} AS ${data.alias}_denominator`
                    : ""
                }`
            )
            .join(",\n")}
          ${eventQuantileData
            .map(
              (data) =>
                `, COUNT(umj.${data.alias}_value) AS ${data.alias}_n_events`
            )
            .join("\n")}
        FROM
          __userMetricJoin umj
        ${
          eventQuantileData.length
            ? `
        LEFT JOIN __eventQuantileMetric qm
        ON (qm.dimension = umj.dimension AND qm.variation = umj.variation)`
            : ""
        }
        GROUP BY
          umj.variation,
          umj.dimension,
          ${cumulativeDate ? "umj.day," : ""}
          ${banditDates?.length ? `umj.bandit_period,` : ""}
          umj.${baseIdType}
      )
      ${
        percentileData.length > 0
          ? `
        , __capValue AS (
            ${this.percentileCapSelectClause(percentileData, "__userMetricAgg")}
        )
        `
          : ""
      }
      ${
        regressionAdjustedMetrics.length > 0
          ? `
        , __userCovariateMetric as (
          SELECT
            d.variation AS variation,
            d.dimension AS dimension,
            d.${baseIdType} AS ${baseIdType},
            ${regressionAdjustedMetrics
              .map(
                (metric) =>
                  `${this.getAggregateMetricColumn({
                    metric: metric.metric,
                    useDenominator: false,
                    valueColumn: this.ifElse(
                      `m.timestamp >= d.${metric.alias}_preexposure_start AND m.timestamp < d.${metric.alias}_preexposure_end`,
                      `${metric.alias}_value`,
                      "NULL"
                    ),
                  })} as ${metric.alias}_value
                    ${
                      metric.ratioMetric
                        ? `, ${this.getAggregateMetricColumn({
                            metric: metric.metric,
                            useDenominator: true,
                            valueColumn: this.ifElse(
                              `m.timestamp >= d.${metric.alias}_preexposure_start AND m.timestamp < d.${metric.alias}_preexposure_end`,
                              `${metric.alias}_denominator`,
                              "NULL"
                            ),
                          })} AS ${metric.alias}_denominator`
                        : ""
                    }`
              )
              .join(",\n")}
          FROM
            __distinctUsers d
          JOIN __factTable m ON (
            m.${baseIdType} = d.${baseIdType}
          )
          WHERE 
            m.timestamp >= d.min_preexposure_start
            AND m.timestamp < d.max_preexposure_end
          GROUP BY
            d.variation,
            d.dimension,
            d.${baseIdType}
        )
        `
          : ""
      }
      ${
        banditDates?.length
          ? this.getBanditStatisticsCTE({
              baseIdType,
              factMetrics: true,
              metricData,
              hasRegressionAdjustment: regressionAdjustedMetrics.length > 0,
              hasCapping: percentileData.length > 0,
            })
          : `
      -- One row per variation/dimension with aggregations
      SELECT
        m.variation AS variation,
        ${
          cumulativeDate ? `${this.formatDate("m.day")}` : "m.dimension"
        } AS dimension,
        COUNT(*) AS users,
        ${metricData.map((data) => {
          return `
           ${this.castToString(`'${data.id}'`)} as ${data.alias}_id,
            ${
              data.isPercentileCapped
                ? `MAX(COALESCE(cap.${data.alias}_value_cap, 0)) as ${data.alias}_main_cap_value,`
                : ""
            }
            SUM(${data.capCoalesceMetric}) AS ${data.alias}_main_sum,
            SUM(POWER(${data.capCoalesceMetric}, 2)) AS ${
            data.alias
          }_main_sum_squares
            ${
              data.quantileMetric === "event"
                ? `
              , SUM(COALESCE(m.${data.alias}_n_events, 0)) AS ${
                    data.alias
                  }_denominator_sum
              , SUM(POWER(COALESCE(m.${data.alias}_n_events, 0), 2)) AS ${
                    data.alias
                  }_denominator_sum_squares
              , SUM(COALESCE(m.${data.alias}_n_events, 0) * ${
                    data.capCoalesceMetric
                  }) AS ${data.alias}_main_denominator_sum_product
              , SUM(COALESCE(m.${data.alias}_n_events, 0)) AS ${
                    data.alias
                  }_quantile_n
              , MAX(qm.${data.alias}_quantile) AS ${data.alias}_quantile
                ${N_STAR_VALUES.map(
                  (
                    n
                  ) => `, MAX(qm.${data.alias}_quantile_lower_${n}) AS ${data.alias}_quantile_lower_${n}
                        , MAX(qm.${data.alias}_quantile_upper_${n}) AS ${data.alias}_quantile_upper_${n}`
                ).join("\n")}`
                : ""
            }
            ${
              data.quantileMetric === "unit"
                ? `${this.getQuantileGridColumns(
                    data.metricQuantileSettings,
                    `${data.alias}_`
                  )}
                  , COUNT(m.${data.alias}_value) AS ${data.alias}_quantile_n`
                : ""
            }
            ${
              data.ratioMetric
                ? `,
                ${
                  data.isPercentileCapped
                    ? `MAX(COALESCE(cap.${data.alias}_denominator_cap, 0)) as ${data.alias}_denominator_cap_value,`
                    : ""
                }
                SUM(${data.capCoalesceDenominator}) AS 
                  ${data.alias}_denominator_sum,
                SUM(POWER(${data.capCoalesceDenominator}, 2)) AS 
                  ${data.alias}_denominator_sum_squares
                ${
                  data.regressionAdjusted
                    ? `, 
                  SUM(${data.capCoalesceCovariate}) AS ${data.alias}_covariate_sum,
                  SUM(POWER(${data.capCoalesceCovariate}, 2)) AS ${data.alias}_covariate_sum_squares,
                  SUM(${data.capCoalesceDenominatorCovariate}) AS ${data.alias}_denominator_pre_sum,
                  SUM(POWER(${data.capCoalesceDenominatorCovariate}, 2)) AS ${data.alias}_denominator_pre_sum_squares,              
                  SUM(${data.capCoalesceMetric} * ${data.capCoalesceDenominator}) AS ${data.alias}_main_denominator_sum_product, 
                  SUM(${data.capCoalesceMetric} * ${data.capCoalesceCovariate}) AS ${data.alias}_main_covariate_sum_product, 
                  SUM(${data.capCoalesceMetric} * ${data.capCoalesceDenominatorCovariate}) AS ${data.alias}_main_post_denominator_pre_sum_product, 
                  SUM(${data.capCoalesceCovariate} * ${data.capCoalesceDenominator}) AS ${data.alias}_main_pre_denominator_post_sum_product,
                  SUM(${data.capCoalesceCovariate} * ${data.capCoalesceDenominatorCovariate}) AS ${data.alias}_main_pre_denominator_pre_sum_product, 
                  SUM(${data.capCoalesceDenominator} * ${data.capCoalesceDenominatorCovariate}) AS ${data.alias}_denominator_post_denominator_pre_sum_product
                  `
                    : `,
                    SUM(${data.capCoalesceDenominator} * ${data.capCoalesceMetric}) AS ${data.alias}_main_denominator_sum_product
                  `
                }` /*ends ifelse regressionAdjusted*/
                : ` 
              ${
                data.regressionAdjusted
                  ? `,
                SUM(${data.capCoalesceCovariate}) AS ${data.alias}_covariate_sum,
                SUM(POWER(${data.capCoalesceCovariate}, 2)) AS ${data.alias}_covariate_sum_squares,
                SUM(${data.capCoalesceMetric} * ${data.capCoalesceCovariate}) AS ${data.alias}_main_covariate_sum_product
                `
                  : ""
              }
            `
            }
          `; /*ends ifelse ratioMetric*/
        })}
      FROM
        __userMetricAgg m
        ${
          eventQuantileData.length
            ? `LEFT JOIN __eventQuantileMetric qm ON (
          qm.dimension = m.dimension AND qm.variation = m.variation
            )`
            : ""
        }
      ${
        regressionAdjustedMetrics.length > 0
          ? `
          LEFT JOIN __userCovariateMetric c
          ON (c.${baseIdType} = m.${baseIdType})
          `
          : ""
      }
      ${percentileData.length > 0 ? `CROSS JOIN __capValue cap` : ""}
      GROUP BY
        m.variation
        , ${cumulativeDate ? `${this.formatDate("m.day")}` : "m.dimension"}
    `
      }`,
      this.getFormatDialect()
    );
    // TODO cumulativeDate in more places
  }
  getExperimentMetricQuery(params: ExperimentMetricQueryParams): string {
    const {
      metric: metricDoc,
      denominatorMetrics: denominatorMetricsDocs,
      activationMetric: activationMetricDoc,
      settings,
      segment,
    } = params;

    const factTableMap = params.factTableMap;

    // clone the metrics before we mutate them
    const metric = cloneDeep<ExperimentMetricInterface>(metricDoc);
    let denominatorMetrics = cloneDeep<ExperimentMetricInterface[]>(
      denominatorMetricsDocs
    );
    const activationMetric = this.processActivationMetric(
      activationMetricDoc,
      settings
    );

    // Fact metrics are self-contained, so they don't need to reference other metrics for the denominator
    if (isFactMetric(metric)) {
      denominatorMetrics = [];
      if (isRatioMetric(metric)) {
        denominatorMetrics.push(metric);
      }
    }

    applyMetricOverrides(metric, settings);
    denominatorMetrics.forEach((m) => applyMetricOverrides(m, settings));

    // Replace any placeholders in the user defined dimension SQL
    const { unitDimensions } = this.processDimensions(
      params.dimensions,
      settings,
      activationMetric
    );

    const userIdType =
      params.forcedUserIdType ??
      this.getExposureQuery(settings.exposureQueryId || "").userIdType;

    const denominator = denominatorMetrics[denominatorMetrics.length - 1];
    // If the denominator is a binomial, it's just acting as a filter
    // e.g. "Purchase/Signup" is filtering to users who signed up and then counting purchases
    // When the denominator is a count, it's a real ratio, dividing two quantities
    // e.g. "Pages/Session" is dividing number of page views by number of sessions
    const ratioMetric = isRatioMetric(metric, denominator);
    const funnelMetric = isFunnelMetric(metric, denominator);

    const quantileMetric = quantileMetricType(metric);
    if (quantileMetric && !this.hasQuantileTesting()) {
      throw new Error("Quantile metrics not supported by this warehouse type");
    }
    const metricQuantileSettings: MetricQuantileSettings = (isFactMetric(
      metric
    ) && !!quantileMetric
      ? metric.quantileSettings
      : undefined) ?? {
      type: "unit",
      quantile: 0,
      ignoreZeros: false,
    };

    const cumulativeDate = false; // TODO enable flag for time series
    const banditDates = settings.banditSettings?.historicalWeights.map(
      (w) => w.date
    );

    // redundant checks to make sure configuration makes sense and we only build expensive queries for the cases
    // where RA is actually possible
    const regressionAdjusted =
      settings.regressionAdjustmentEnabled &&
      isRegressionAdjusted(metric, denominator) &&
      // and block RA for experiment metric query only, only works for optimized queries
      !isRatioMetric(metric, denominator);

    const regressionAdjustmentHours = regressionAdjusted
      ? (metric.regressionAdjustmentDays ?? 0) * 24
      : 0;

    const overrideConversionWindows =
      settings.attributionModel === "experimentDuration";

    // Get capping settings and final coalesce statement
    const isPercentileCapped =
      metric.cappingSettings.type === "percentile" &&
      !!metric.cappingSettings.value &&
      metric.cappingSettings.value < 1 &&
      !quantileMetric;

    const denominatorIsPercentileCapped =
      denominator &&
      denominator.cappingSettings.type === "percentile" &&
      !!denominator.cappingSettings.value &&
      denominator.cappingSettings.value < 1 &&
      !quantileMetric;
    const capCoalesceMetric = this.capCoalesceValue({
      valueCol: "m.value",
      metric,
      capTablePrefix: "cap",
      columnRef: isFactMetric(metric) ? metric.numerator : null,
    });
    const capCoalesceDenominator = this.capCoalesceValue({
      valueCol: "d.value",
      metric: denominator,
      capTablePrefix: "capd",
      columnRef: isFactMetric(metric) ? metric.denominator : null,
    });
    const capCoalesceCovariate = this.capCoalesceValue({
      valueCol: "c.value",
      metric: metric,
      capTablePrefix: "cap",
      columnRef: isFactMetric(metric) ? metric.numerator : null,
    });

    // Get rough date filter for metrics to improve performance
    const orderedMetrics = (activationMetric ? [activationMetric] : [])
      .concat(denominatorMetrics)
      .concat([metric]);
    const minMetricDelay = this.getMetricMinDelay(orderedMetrics);
    const metricStart = this.getMetricStart(
      settings.startDate,
      minMetricDelay,
      regressionAdjustmentHours
    );
    const metricEnd = this.getMetricEnd(
      orderedMetrics,
      settings.endDate,
      overrideConversionWindows
    );

    // Get any required identity join queries
    const idTypeObjects = [
      [userIdType],
      getUserIdTypes(metric, factTableMap),
      ...denominatorMetrics.map((m) => getUserIdTypes(m, factTableMap, true)),
    ];
    // add idTypes usually handled in units query here in the case where
    // we don't have a separate table for the units query
    if (params.unitsSource === "exposureQuery") {
      idTypeObjects.push(
        ...unitDimensions.map((d) => [d.dimension.userIdType || "user_id"]),
        segment ? [segment.userIdType || "user_id"] : [],
        activationMetric ? getUserIdTypes(activationMetric, factTableMap) : []
      );
    }
    const { baseIdType, idJoinMap, idJoinSQL } = this.getIdentitiesCTE({
      objects: idTypeObjects,
      from: settings.startDate,
      to: settings.endDate,
      forcedBaseIdType: userIdType,
      experimentId: settings.experimentId,
    });

    // Get date range for experiment and analysis
    const startDate: Date = settings.startDate;
    const endDate: Date = this.getExperimentEndDate(
      settings,
      this.getMaxHoursToConvert(
        funnelMetric,
        [metric].concat(denominatorMetrics),
        activationMetric
      )
    );

    if (params.dimensions.length > 1) {
      throw new Error(
        "Multiple dimensions not supported in metric analysis yet. Please contact GrowthBook."
      );
    }
    const dimension = params.dimensions[0];
    let dimensionCol = this.castToString("''");
    if (dimension?.type === "experiment") {
      dimensionCol = `dim_exp_${dimension.id}`;
    } else if (dimension?.type === "user") {
      dimensionCol = `dim_unit_${dimension.dimension.id}`;
    } else if (dimension?.type === "date") {
      dimensionCol = `${this.formatDate(
        this.dateTrunc("first_exposure_timestamp")
      )}`;
    } else if (dimension?.type === "activation") {
      dimensionCol = this.ifElse(
        `first_activation_timestamp IS NULL`,
        "'Not Activated'",
        "'Activated'"
      );
    }

    const timestampColumn =
      activationMetric && dimension?.type !== "activation"
        ? "first_activation_timestamp"
        : "first_exposure_timestamp";

    const distinctUsersWhere: string[] = [];
    if (activationMetric && dimension?.type !== "activation") {
      distinctUsersWhere.push("first_activation_timestamp IS NOT NULL");
    }
    if (settings.skipPartialData) {
      distinctUsersWhere.push(
        `${timestampColumn} <= ${this.toTimestamp(endDate)}`
      );
    }

    return format(
      `-- ${metric.name} (${
        isFactMetric(metric) ? metric.metricType : metric.type
      })
    WITH
      ${idJoinSQL}
      ${
        params.unitsSource === "exposureQuery"
          ? `${this.getExperimentUnitsQuery({
              ...params,
              includeIdJoins: false,
            })},`
          : params.unitsSource === "otherQuery"
          ? params.unitsSql
          : ""
      }
      __distinctUsers AS (
        SELECT
          ${baseIdType},
          ${dimensionCol} AS dimension,
          variation,
          ${timestampColumn} AS timestamp,
          ${this.dateTrunc("first_exposure_timestamp")} AS first_exposure_date
          ${banditDates?.length ? this.getBanditCaseWhen(banditDates) : ""}
          ${
            regressionAdjusted
              ? `, ${this.addHours(
                  "first_exposure_timestamp",
                  minMetricDelay
                )} AS preexposure_end
                , ${this.addHours(
                  "first_exposure_timestamp",
                  minMetricDelay - regressionAdjustmentHours
                )} AS preexposure_start`
              : ""
          }
        FROM ${
          params.unitsSource === "exposureTable"
            ? `${params.unitsTableFullName}`
            : "__experimentUnits"
        }
        ${
          distinctUsersWhere.length
            ? `WHERE ${distinctUsersWhere.join(" AND ")}`
            : ""
        }
      )
      , __metric as (${this.getMetricCTE({
        metric,
        baseIdType,
        idJoinMap,
        startDate: metricStart,
        endDate: metricEnd,
        experimentId: settings.experimentId,
        factTableMap,
      })})
      ${denominatorMetrics
        .map((m, i) => {
          return `, __denominator${i} as (${this.getMetricCTE({
            metric: m,
            baseIdType,
            idJoinMap,
            startDate: metricStart,
            endDate: metricEnd,
            experimentId: settings.experimentId,
            factTableMap,
            useDenominator: true,
          })})`;
        })
        .join("\n")}
      ${
        funnelMetric
          ? `, __denominatorUsers as (${this.getFunnelUsersCTE(
              baseIdType,
              denominatorMetrics,
              settings.endDate,
              regressionAdjusted,
              cumulativeDate,
              overrideConversionWindows,
              banditDates,
              "__denominator",
              "__distinctUsers"
            )})`
          : ""
      }
      ${
        cumulativeDate
          ? `, __dateRange AS (
        ${this.getDateTable(
          dateStringArrayBetweenDates(startDate, endDate || new Date())
        )}
      )`
          : ""
      }
      , __userMetricJoin as (
        SELECT
          d.variation AS variation,
          d.dimension AS dimension,
          ${banditDates?.length ? `d.bandit_period AS bandit_period,` : ""}
          ${cumulativeDate ? `dr.day AS day,` : ""}
          d.${baseIdType} AS ${baseIdType},
          ${this.addCaseWhenTimeFilter(
            "m.value",
            metric,
            overrideConversionWindows,
            settings.endDate,
            cumulativeDate,
            quantileMetric ? metricQuantileSettings : undefined
          )} as value
        FROM
          ${funnelMetric ? "__denominatorUsers" : "__distinctUsers"} d
        LEFT JOIN __metric m ON (
          m.${baseIdType} = d.${baseIdType}
        )
        ${
          cumulativeDate
            ? `
            CROSS JOIN __dateRange dr
            WHERE d.first_exposure_date <= dr.day
          `
            : ""
        }
      )
      ${
        quantileMetric === "event"
          ? `
          , __quantileMetric AS (
            SELECT
              m.variation,
              m.dimension
              ${this.getQuantileGridColumns(metricQuantileSettings, "")}
          FROM
            __userMetricJoin m
          GROUP BY
            m.variation,
            m.dimension
          )`
          : ""
      }
      , __userMetricAgg as (
        -- Add in the aggregate metric value for each user
        SELECT
          umj.variation AS variation,
          umj.dimension AS dimension,
          ${banditDates?.length ? `umj.bandit_period AS bandit_period,` : ""}
          ${cumulativeDate ? "umj.day AS day," : ""}
          umj.${baseIdType},
          ${this.getAggregateMetricColumn({
            metric,
            valueColumn: "umj.value",
          })} as value
          ${quantileMetric === "event" ? `, COUNT(umj.value) AS n_events` : ""}
        FROM
          __userMetricJoin umj
        ${
          quantileMetric === "event"
            ? `
        LEFT JOIN __quantileMetric qm
        ON (qm.dimension = umj.dimension AND qm.variation = umj.variation)`
            : ""
        }
        GROUP BY
          umj.variation,
          umj.dimension,
          ${cumulativeDate ? "umj.day," : ""}
          ${banditDates?.length ? `umj.bandit_period,` : ""}
          umj.${baseIdType}
      )
      ${
        isPercentileCapped
          ? `
        , __capValue AS (
            ${this.percentileCapSelectClause(
              [
                {
                  valueCol: "value",
                  outputCol: "value_cap",
                  percentile: metric.cappingSettings.value ?? 1,
                  ignoreZeros: metric.cappingSettings.ignoreZeros ?? false,
                },
              ],
              "__userMetricAgg",
              `WHERE value IS NOT NULL${
                metric.cappingSettings.ignoreZeros ? " AND value != 0" : ""
              }`
            )}
        )
        `
          : ""
      }
      ${
        ratioMetric
          ? `, __userDenominatorAgg AS (
              SELECT
                d.variation AS variation,
                d.dimension AS dimension,
                ${
                  banditDates?.length ? `d.bandit_period AS bandit_period,` : ""
                }
                ${cumulativeDate ? `dr.day AS day,` : ""}
                d.${baseIdType} AS ${baseIdType},
                ${this.getAggregateMetricColumn({
                  metric: denominator,
                  useDenominator: true,
                })} as value
              FROM
                __distinctUsers d
                JOIN __denominator${denominatorMetrics.length - 1} m ON (
                  m.${baseIdType} = d.${baseIdType}
                )
                ${cumulativeDate ? "CROSS JOIN __dateRange dr" : ""}
              WHERE
                ${this.getConversionWindowClause(
                  "d.timestamp",
                  "m.timestamp",
                  denominator,
                  settings.endDate,
                  cumulativeDate,
                  overrideConversionWindows
                )}
                ${
                  cumulativeDate
                    ? `AND ${this.castToDate(
                        "m.timestamp"
                      )} <= dr.day AND d.first_exposure_date <= dr.day`
                    : ""
                }
              GROUP BY
                d.variation,
                d.dimension,
                ${banditDates?.length ? `d.bandit_period,` : ""}
                ${cumulativeDate ? `dr.day,` : ""}
                d.${baseIdType}
            )
            ${
              denominatorIsPercentileCapped
                ? `
              , __capValueDenominator AS (
                ${this.percentileCapSelectClause(
                  [
                    {
                      valueCol: "value",
                      outputCol: "value_cap",
                      percentile: denominator.cappingSettings.value ?? 1,
                      ignoreZeros:
                        denominator.cappingSettings.ignoreZeros ?? false,
                    },
                  ],
                  "__userDenominatorAgg",
                  `WHERE value IS NOT NULL${
                    denominator.cappingSettings.ignoreZeros
                      ? " AND value != 0"
                      : ""
                  }`
                )}
              )
              `
                : ""
            }`
          : ""
      }
      ${
        regressionAdjusted
          ? `
        , __userCovariateMetric as (
          SELECT
            d.variation AS variation,
            d.dimension AS dimension,
            d.${baseIdType} AS ${baseIdType},
            ${this.getAggregateMetricColumn({ metric })} as value
          FROM
            __distinctUsers d
          JOIN __metric m ON (
            m.${baseIdType} = d.${baseIdType}
          )
          WHERE 
            m.timestamp >= d.preexposure_start
            AND m.timestamp < d.preexposure_end
          GROUP BY
            d.variation,
            d.dimension,
            d.${baseIdType}
        )
        `
          : ""
      }
  ${
    banditDates?.length
      ? this.getBanditStatisticsCTE({
          baseIdType,
          factMetrics: false,
          metricData: [
            {
              alias: "",
              id: metric.id,
              ratioMetric,
              regressionAdjusted,
              isPercentileCapped,
              capCoalesceMetric,
              capCoalesceCovariate,
              capCoalesceDenominator,
            },
          ],
          hasRegressionAdjustment: regressionAdjusted,
          hasCapping: isPercentileCapped || denominatorIsPercentileCapped,
          ignoreNulls: "ignoreNulls" in metric && metric.ignoreNulls,
          denominatorIsPercentileCapped,
        })
      : `
  -- One row per variation/dimension with aggregations
  SELECT
    m.variation AS variation,
    ${
      cumulativeDate ? `${this.formatDate("m.day")}` : "m.dimension"
    } AS dimension,
    COUNT(*) AS users,
    ${
      isPercentileCapped
        ? "MAX(COALESCE(cap.value_cap, 0)) as main_cap_value,"
        : ""
    }
    SUM(${capCoalesceMetric}) AS main_sum,
    SUM(POWER(${capCoalesceMetric}, 2)) AS main_sum_squares
    ${
      quantileMetric === "event"
        ? `, SUM(COALESCE(m.n_events, 0)) AS denominator_sum
      , SUM(POWER(COALESCE(m.n_events, 0), 2)) AS denominator_sum_squares
      , SUM(COALESCE(m.n_events, 0) * ${capCoalesceMetric}) AS main_denominator_sum_product
      , SUM(COALESCE(m.n_events, 0)) AS quantile_n
      , MAX(qm.quantile) AS quantile
        ${N_STAR_VALUES.map(
          (n) => `, MAX(qm.quantile_lower_${n}) AS quantile_lower_${n}
                , MAX(qm.quantile_upper_${n}) AS quantile_upper_${n}`
        ).join("\n")}`
        : ""
    }
    ${
      quantileMetric === "unit"
        ? `${this.getQuantileGridColumns(metricQuantileSettings, "")}
        , COUNT(m.value) AS quantile_n`
        : ""
    }
    ${
      ratioMetric
        ? `,
      ${
        denominatorIsPercentileCapped
          ? "MAX(COALESCE(capd.value_cap, 0)) as denominator_cap_value,"
          : ""
      }
      SUM(${capCoalesceDenominator}) AS denominator_sum,
      SUM(POWER(${capCoalesceDenominator}, 2)) AS denominator_sum_squares,
      SUM(${capCoalesceDenominator} * ${capCoalesceMetric}) AS main_denominator_sum_product
    `
        : ""
    }
    ${
      regressionAdjusted
        ? `,
      SUM(${capCoalesceCovariate}) AS covariate_sum,
      SUM(POWER(${capCoalesceCovariate}, 2)) AS covariate_sum_squares,
      SUM(${capCoalesceMetric} * ${capCoalesceCovariate}) AS main_covariate_sum_product
      `
        : ""
    }
  FROM
    __userMetricAgg m
    ${
      quantileMetric === "event"
        ? `LEFT JOIN __quantileMetric qm ON (
      qm.dimension = m.dimension AND qm.variation = m.variation
        )`
        : ""
    }
  ${
    ratioMetric
      ? `LEFT JOIN __userDenominatorAgg d ON (
          d.${baseIdType} = m.${baseIdType}
          ${cumulativeDate ? "AND d.day = m.day" : ""}
        )
        ${
          denominatorIsPercentileCapped
            ? "CROSS JOIN __capValueDenominator capd"
            : ""
        }`
      : ""
  }
  ${
    regressionAdjusted
      ? `
      LEFT JOIN __userCovariateMetric c
      ON (c.${baseIdType} = m.${baseIdType})
      `
      : ""
  }
  ${isPercentileCapped ? `CROSS JOIN __capValue cap` : ""}
  ${"ignoreNulls" in metric && metric.ignoreNulls ? `WHERE m.value != 0` : ""}
  GROUP BY
    m.variation
    , ${cumulativeDate ? `${this.formatDate("m.day")}` : "m.dimension"}
  `
  }`,
      this.getFormatDialect()
    );
  }

  getBanditStatisticsCTE({
    baseIdType,
    factMetrics,
    metricData,
    hasRegressionAdjustment,
    hasCapping,
    ignoreNulls,
    denominatorIsPercentileCapped,
  }: {
    baseIdType: string;
    factMetrics: boolean;
    metricData: BanditMetricData[];
    hasRegressionAdjustment: boolean;
    hasCapping: boolean;
    // legacy metric settings
    ignoreNulls?: boolean;
    denominatorIsPercentileCapped?: boolean;
  }): string {
    return `-- One row per variation/dimension with aggregations
  , __banditPeriodStatistics AS (
    SELECT
      m.variation AS variation
      , m.dimension AS dimension
      , m.bandit_period AS bandit_period
      , ${this.ensureFloat(`COUNT(*)`)} AS users
      ${metricData
        .map((data) => {
          const alias = data.alias + (factMetrics ? "_" : "");
          return `
        ${
          data.isPercentileCapped
            ? `, MAX(COALESCE(cap.${alias}value_cap, 0)) AS ${alias}main_cap_value`
            : ""
        }
        , ${this.ensureFloat(
          `SUM(${data.capCoalesceMetric})`
        )} AS ${alias}main_sum
        , ${this.ensureFloat(
          `SUM(POWER(${data.capCoalesceMetric}, 2))`
        )} AS ${alias}main_sum_squares
        ${
          data.ratioMetric
            ? `
          ${
            (factMetrics && data.isPercentileCapped) ||
            denominatorIsPercentileCapped
              ? `, MAX(COALESCE(capd.${alias}value_cap, 0)) as ${alias}denominator_cap_value`
              : ""
          }
          , ${this.ensureFloat(
            `SUM(${data.capCoalesceDenominator})`
          )} AS ${alias}denominator_sum
          , ${this.ensureFloat(
            `SUM(POWER(${data.capCoalesceDenominator}, 2))`
          )} AS ${alias}denominator_sum_squares
          , ${this.ensureFloat(
            `SUM(${data.capCoalesceDenominator} * ${data.capCoalesceMetric})`
          )} AS ${alias}main_denominator_sum_product
        `
            : ""
        }
        ${
          data.regressionAdjusted
            ? `
          , ${this.ensureFloat(
            `SUM(${data.capCoalesceCovariate})`
          )} AS ${alias}covariate_sum
          , ${this.ensureFloat(
            `SUM(POWER(${data.capCoalesceCovariate}, 2))`
          )} AS ${alias}covariate_sum_squares
          , ${this.ensureFloat(
            `SUM(${data.capCoalesceMetric} * ${data.capCoalesceCovariate})`
          )} AS ${alias}main_covariate_sum_product
          `
            : ""
        }`;
        })
        .join("\n")}
    FROM
      __userMetricAgg m
    ${
      !factMetrics && metricData[0]?.ratioMetric
        ? `LEFT JOIN __userDenominatorAgg d ON (
            d.${baseIdType} = m.${baseIdType}
          )
          ${
            denominatorIsPercentileCapped
              ? "CROSS JOIN __capValueDenominator capd"
              : ""
          }`
        : ""
    }
    ${
      hasRegressionAdjustment
        ? `
        LEFT JOIN __userCovariateMetric c
        ON (c.${baseIdType} = m.${baseIdType})
        `
        : ""
    }
    ${hasCapping ? `CROSS JOIN __capValue cap` : ""}
    ${!factMetrics && ignoreNulls ? `WHERE m.value != 0` : ""}
    GROUP BY
      m.variation
      , m.bandit_period
      , m.dimension
  ),
  __dimensionTotals AS (
    SELECT
      dimension
      , ${this.ensureFloat(`SUM(users)`)} AS total_users
    FROM 
      __banditPeriodStatistics
    GROUP BY
      dimension
  ),
  __banditPeriodWeights AS (
    SELECT
      bps.bandit_period
      , bps.dimension
      , SUM(bps.users) / MAX(dt.total_users) AS weight
      ${metricData
        .map((data) => {
          const alias = data.alias + (factMetrics ? "_" : "");
          return `
      ${
        data.regressionAdjusted
          ? `
          , ${this.ifElse(
            `(SUM(bps.users) - 1) <= 0`,
            "0",
            `(
              SUM(bps.${alias}covariate_sum_squares) - 
              POWER(SUM(bps.${alias}covariate_sum), 2) / SUM(bps.users)
            ) / (SUM(bps.users) - 1)`
          )} AS ${alias}period_pre_variance
          , ${this.ifElse(
            `(SUM(bps.users) - 1) <= 0`,
            "0",
            `(
              SUM(bps.${alias}main_covariate_sum_product) - 
              SUM(bps.${alias}covariate_sum) * SUM(bps.${alias}main_sum) / SUM(bps.users)
            ) / (SUM(bps.users) - 1)`
          )} AS ${alias}period_covariance
        `
          : ""
      }`;
        })
        .join("\n")}
    FROM 
      __banditPeriodStatistics bps
    LEFT JOIN
      __dimensionTotals dt 
      ON (bps.dimension = dt.dimension)
    GROUP BY
      bps.bandit_period
      , bps.dimension
  )
  ${
    hasRegressionAdjustment
      ? `
      , __theta AS (
      SELECT
        dimension
      ${metricData
        .map((data) => {
          const alias = data.alias + (factMetrics ? "_" : "");
          return `
      ${
        data.regressionAdjusted
          ? `

          , ${this.ifElse(
            `SUM(POWER(weight, 2) * ${alias}period_pre_variance) <= 0`,
            "0",
            `SUM(POWER(weight, 2) * ${alias}period_covariance) / 
          SUM(POWER(weight, 2) * ${alias}period_pre_variance)`
          )} AS ${alias}theta
        `
          : ""
      }`;
        })
        .join("\n")}
      FROM
        __banditPeriodWeights
      GROUP BY
        dimension
      )
    `
      : ""
  }
  SELECT
    bps.variation
    , bps.dimension
    , SUM(bps.users) AS users
    ${metricData
      .map((data) => {
        const alias = data.alias + (factMetrics ? "_" : "");
        return `
    , ${this.castToString(`'${data.id}'`)} as ${alias}id
    , SUM(bpw.weight * bps.${alias}main_sum / bps.users) * SUM(bps.users) AS ${alias}main_sum
    , SUM(bps.users) * (SUM(
      ${this.ifElse(
        "bps.users <= 1",
        "0",
        `POWER(bpw.weight, 2) * ((
        bps.${alias}main_sum_squares - POWER(bps.${alias}main_sum, 2) / bps.users
      ) / (bps.users - 1)) / bps.users
    `
      )}) * (SUM(bps.users) - 1) + POWER(SUM(bpw.weight * bps.${alias}main_sum / bps.users), 2)) as ${alias}main_sum_squares
    ${
      data.ratioMetric
        ? `
      , SUM(bpw.weight * bps.${alias}denominator_sum / bps.users) * SUM(bps.users) AS ${alias}denominator_sum
      , SUM(bps.users) * (SUM(
      ${this.ifElse(
        "bps.users <= 1",
        "0",
        `POWER(bpw.weight, 2) * ((
          (bps.${alias}denominator_sum_squares - POWER(bps.${alias}denominator_sum, 2) / bps.users) / (bps.users - 1))
        ) / bps.users
      `
      )}) * (SUM(bps.users) - 1) + POWER(
        SUM(bpw.weight * bps.${alias}denominator_sum / bps.users), 2)
      ) AS ${alias}denominator_sum_squares
      , SUM(bps.users) * (
          (SUM(bps.users) - 1) * SUM(
            ${this.ifElse(
              "bps.users <= 1",
              "0",
              `
            POWER(bpw.weight, 2) / (bps.users * (bps.users - 1)) * (
              bps.${alias}main_denominator_sum_product - bps.${alias}main_sum * bps.${alias}denominator_sum / bps.users
            )
          `
            )}) +
          (
            SUM(bpw.weight * bps.${alias}main_sum / bps.users) * SUM(bpw.weight * bps.${alias}denominator_sum / bps.users)
          )
        ) AS ${alias}main_denominator_sum_product`
        : ""
    }
    ${
      data.regressionAdjusted
        ? `
      , SUM(bpw.weight * bps.${alias}covariate_sum / bps.users) * SUM(bps.users) AS ${alias}covariate_sum
      , SUM(bps.users) * (SUM(
      ${this.ifElse(
        "bps.users <= 1",
        "0",
        `POWER(bpw.weight, 2) * ((
          (bps.${alias}covariate_sum_squares - POWER(bps.${alias}covariate_sum, 2) / bps.users) / (bps.users - 1))
        ) / bps.users
      `
      )}) * (SUM(bps.users) - 1) + POWER(SUM(bpw.weight * bps.${alias}covariate_sum / bps.users), 2)) AS ${alias}covariate_sum_squares
      , SUM(bps.users) * (
          (SUM(bps.users) - 1) * SUM(
            ${this.ifElse(
              "bps.users <= 1",
              "0",
              `
            POWER(bpw.weight, 2) / (bps.users * (bps.users - 1)) * (
              bps.${alias}main_covariate_sum_product - bps.${alias}main_sum * bps.${alias}covariate_sum / bps.users
            )
          `
            )}) +
          (
            SUM(bpw.weight * bps.${alias}main_sum / bps.users) * SUM(bpw.weight * bps.${alias}covariate_sum / bps.users)
          )
        ) AS ${alias}main_covariate_sum_product
      , MAX(t.${alias}theta) AS ${alias}theta
        `
        : ""
    }`;
      })
      .join("\n")}
  FROM 
    __banditPeriodStatistics bps
  LEFT JOIN
    __banditPeriodWeights bpw
    ON (
      bps.bandit_period = bpw.bandit_period 
      AND bps.dimension = bpw.dimension
    )
  ${
    hasRegressionAdjustment
      ? `
    LEFT JOIN
      __theta t
      ON (bps.dimension = t.dimension)
    `
      : ""
  }
  GROUP BY
    bps.variation
    , bps.dimension
  `;
  }

  getQuantileBoundValues(
    quantile: number,
    alpha: number,
    nstar: number
  ): { lower: number; upper: number } {
    const multiplier = normal.quantile(1 - alpha / 2, 0, 1);
    const binomialSE = Math.sqrt((quantile * (1 - quantile)) / nstar);
    return {
      lower: Math.max(quantile - multiplier * binomialSE, 0.00000001),
      upper: Math.min(quantile + multiplier * binomialSE, 0.99999999),
    };
  }

  approxQuantile(value: string, quantile: string | number): string {
    return `APPROX_PERCENTILE(${value}, ${quantile})`;
  }

  quantileColumn(
    valueCol: string,
    outputCol: string,
    quantile: string | number
  ): string {
    // note: no need to ignore zeros in the next two methods
    // since we remove them for quantile metrics in userMetricJoin
    return `${this.approxQuantile(valueCol, quantile)} AS ${outputCol}`;
  }

  percentileCapSelectClause(
    values: {
      valueCol: string;
      outputCol: string;
      percentile: number;
      ignoreZeros: boolean;
    }[],
    metricTable: string,
    where: string = ""
  ) {
    return `
      SELECT
        ${values
          .map(({ valueCol, outputCol, percentile, ignoreZeros }) => {
            const value = ignoreZeros
              ? this.ifElse(`${valueCol} = 0`, "NULL", valueCol)
              : valueCol;
            return this.quantileColumn(value, outputCol, percentile);
          })
          .join(",\n")}
      FROM ${metricTable}
      ${where}
      `;
  }

  private capCoalesceValue({
    valueCol,
    metric,
    capTablePrefix = "c",
    capValueCol = "value_cap",
    columnRef,
  }: {
    valueCol: string;
    metric: ExperimentMetricInterface;
    capTablePrefix?: string;
    capValueCol?: string;
    columnRef?: ColumnRef | null;
  }): string {
    if (
      metric?.cappingSettings.type === "absolute" &&
      metric.cappingSettings.value &&
      !quantileMetricType(metric)
    ) {
      return `LEAST(
        ${this.ensureFloat(`COALESCE(${valueCol}, 0)`)},
        ${metric.cappingSettings.value}
      )`;
    }
    if (
      metric?.cappingSettings.type === "percentile" &&
      metric.cappingSettings.value &&
      metric.cappingSettings.value < 1 &&
      !quantileMetricType(metric)
    ) {
      return `LEAST(
        ${this.ensureFloat(`COALESCE(${valueCol}, 0)`)},
        ${capTablePrefix}.${capValueCol}
      )`;
    }

    const filters = getAggregateFilters({
      columnRef: columnRef || null,
      column: valueCol,
      ignoreInvalid: true,
    });
    if (filters.length) {
      valueCol = `(CASE WHEN ${filters.join(" AND ")} THEN 1 ELSE NULL END)`;
    }

    return `COALESCE(${valueCol}, 0)`;
  }
  getExperimentResultsQuery(): string {
    throw new Error("Not implemented");
  }
  async getExperimentResults(): Promise<ExperimentQueryResponses> {
    throw new Error("Not implemented");
  }

  getDefaultDatabase() {
    return "";
  }

  generateTablePath(
    tableName: string,
    schema?: string,
    database?: string,
    queryRequiresSchema?: boolean
  ) {
    let path = "";
    // Add database if required
    if (this.requiresDatabase) {
      database = database || this.getDefaultDatabase();
      if (!database) {
        throw new MissingDatasourceParamsError(
          "No database provided. Please edit the connection settings and try again."
        );
      }
      path += database + ".";
    }

    // Add schema if required
    if (this.requiresSchema || queryRequiresSchema) {
      if (!schema) {
        throw new MissingDatasourceParamsError(
          "No schema provided. Please edit the connection settings and try again."
        );
      }
      path += schema + ".";
    }

    // Add table name
    path += tableName;
    return this.requiresEscapingPath ? `\`${path}\`` : path;
  }

  getInformationSchemaTable(schema?: string, database?: string): string {
    return this.generateTablePath(
      "information_schema.columns",
      schema,
      database
    );
  }

  getInformationSchemaWhereClause(): string {
    return "table_schema NOT IN ('information_schema')";
  }
  async getInformationSchema(): Promise<InformationSchema[]> {
    const sql = `
  SELECT 
    table_name as table_name,
    table_catalog as table_catalog,
    table_schema as table_schema,
    count(column_name) as column_count 
  FROM
    ${this.getInformationSchemaTable()}
    WHERE ${this.getInformationSchemaWhereClause()}
    GROUP BY table_name, table_schema, table_catalog`;

    const results = await this.runQuery(format(sql, this.getFormatDialect()));

    if (!results.rows.length) {
      throw new Error(`No tables found.`);
    }

    return formatInformationSchema(results.rows as RawInformationSchema[]);
  }
  async getTableData(
    databaseName: string,
    tableSchema: string,
    tableName: string
  ): Promise<{ tableData: null | unknown[] }> {
    const sql = `
  SELECT 
    data_type as data_type,
    column_name as column_name 
  FROM
    ${this.getInformationSchemaTable(tableSchema, databaseName)}
  WHERE 
    table_name = '${tableName}'
    AND table_schema = '${tableSchema}'
    AND table_catalog = '${databaseName}'`;

    const results = await this.runQuery(format(sql, this.getFormatDialect()));

    return { tableData: results.rows };
  }
  getSchemaFormatConfig(
    schemaFormat: AutoFactTableSchemas
  ): SchemaFormatConfig {
    switch (schemaFormat) {
      case "amplitude": {
        return {
          trackedEventTableName: `EVENTS_${
            this.datasource.settings.schemaOptions?.projectId || `*`
          }`,
          eventColumn: "event_type",
          timestampColumn: "event_time",
          userIdColumn: "user_id",
          filterColumns: [
            "device_family as device",
            "os_name as os",
            "country",
            "paying",
          ],
          anonymousIdColumn: "amplitude_id",
          getTrackedEventTablePath: ({ schema }) =>
            this.generateTablePath(
              `EVENTS_${
                this.datasource.settings.schemaOptions?.projectId || `*`
              }`,
              schema
            ),
          // If dates are provided, format them, otherwise use Sql template variables
          getDateLimitClause: (dates?: { start: Date; end: Date }) => {
            const start = dates
              ? `${formatDate(dates.start, "yyyy-MM-dd")}`
              : `{{date startDateISO "yyyy-MM-dd"}}`;
            const end = dates
              ? `${formatDate(dates.end, "yyyy-MM-dd")}`
              : `{{date endDateISO "yyyy-MM-dd"}}`;

            return `event_time BETWEEN '${start}' AND '${end}'`;
          },
          getAdditionalEvents: () => [],
          getEventFilterWhereClause: (eventName: string) =>
            `event_name = '${eventName}'`,
        };
      }
      case "rudderstack":
      case "segment":
        return {
          trackedEventTableName: "tracks",
          eventColumn: "event",
          timestampColumn: "received_at",
          userIdColumn: "user_id",
          filterColumns: [
            "(CASE WHEN context_user_agent LIKE '%Mobile%' THEN 'Mobile' ELSE 'Tablet/Desktop' END) as device",
            "(CASE WHEN context_user_agent LIKE '% Firefox%' THEN 'Firefox' WHEN context_user_agent LIKE '% OPR%' THEN 'Opera' WHEN context_user_agent LIKE '% Edg%' THEN ' Edge' WHEN context_user_agent LIKE '% Chrome%' THEN 'Chrome' WHEN context_user_agent LIKE '% Safari%' THEN 'Safari' ELSE 'Other' END) as browser",
          ],
          anonymousIdColumn: "anonymous_id",
          displayNameColumn: "event_text",
          getTrackedEventTablePath: ({ eventName, schema }) =>
            this.generateTablePath(eventName, schema),
          getDateLimitClause: (dates?: { start: Date; end: Date }) => {
            // If dates are provided, format them, otherwise use Sql template variables
            const start = dates
              ? `${formatDate(dates.start, "yyyy-MM-dd")}`
              : `{{date startDateISO "yyyy-MM-dd"}}`;
            const end = dates
              ? `${formatDate(dates.end, "yyyy-MM-dd")}`
              : `{{date endDateISO "yyyy-MM-dd"}}`;
            return `received_at BETWEEN '${start}' AND '${end}'`;
          },
          getAdditionalEvents: () => [
            {
              eventName: "pages",
              displayName: "Page Viewed",
              groupBy: "event",
            },
            {
              eventName: "screens",
              displayName: "Screen Viewed",
              groupBy: "event",
            },
          ],
          getEventFilterWhereClause: () => "",
        };
    }
  }

  getAutoGeneratedMetricSqlQuery(
    eventName: string,
    hasUserId: boolean,
    schemaFormat: AutoFactTableSchemas,
    type: MetricType,
    schema?: string
  ): string {
    const {
      timestampColumn,
      userIdColumn,
      anonymousIdColumn,
      getTrackedEventTablePath,
      getEventFilterWhereClause,
      getDateLimitClause,
    } = this.getSchemaFormatConfig(schemaFormat);

    const sqlQuery = `
      SELECT
        ${hasUserId ? `${userIdColumn} as user_id, ` : ""}
        ${anonymousIdColumn} as anonymous_id,
        ${timestampColumn} as timestamp
        ${type === "count" ? `, 1 as value` : ""}
        FROM ${getTrackedEventTablePath({ eventName, schema })}
        WHERE ${getDateLimitClause()} ${
      getEventFilterWhereClause(eventName).length
        ? ` AND ${getEventFilterWhereClause(eventName)}`
        : ""
    }
`;
    return format(sqlQuery, this.getFormatDialect());
  }

  doesMetricExist(
    existingMetrics: MetricInterface[],
    sqlQuery: string,
    type: MetricType
  ): boolean {
    return existingMetrics.some(
      (metric) => metric.sql === sqlQuery && metric.type === type
    );
  }

  getFilterColumnsClause(filterColumns: string[]): string {
    let filterClause = "";
    if (!filterColumns.length) return filterClause;

    filterColumns.forEach((column) => (filterClause += `, ${column}`));

    return filterClause;
  }
  getAutoGeneratedFactTableSqlQuery(
    eventName: string,
    hasUserId: boolean,
    schemaFormat: AutoFactTableSchemas,
    schema?: string
  ): string {
    const {
      timestampColumn,
      userIdColumn,
      anonymousIdColumn,
      getTrackedEventTablePath,
      getEventFilterWhereClause,
      filterColumns,
      getDateLimitClause,
    } = this.getSchemaFormatConfig(schemaFormat);

    const sqlQuery = `
      SELECT
        ${hasUserId ? `${userIdColumn} as user_id, ` : ""}
        ${anonymousIdColumn} as anonymous_id,
        ${timestampColumn} as timestamp
        ${this.getFilterColumnsClause(filterColumns)}
        FROM ${getTrackedEventTablePath({ eventName, schema })}
        WHERE ${getDateLimitClause()} ${
      getEventFilterWhereClause(eventName).length
        ? ` AND ${getEventFilterWhereClause(eventName)}`
        : ""
    }
`;
    return format(sqlQuery, this.getFormatDialect());
  }
  getMetricsToCreate(
    result: TrackedEventData,
    schemaFormat: AutoFactTableSchemas,
    existingMetrics: MetricInterface[],
    schema?: string
  ): AutoMetricToCreate[] {
    const metricsToCreate: AutoMetricToCreate[] = [];

    const userIdTypes: string[] = ["anonymous_id"];

    if (result.hasUserId) {
      userIdTypes.push("user_id");
    }

    const binomialSqlQuery = this.getAutoGeneratedMetricSqlQuery(
      result.eventName,
      result.hasUserId,
      schemaFormat,
      "binomial",
      schema
    );

    const binomialExists = this.doesMetricExist(
      existingMetrics,
      binomialSqlQuery,
      "binomial"
    );

    //TODO Build some logic where based on the event, we determine what metrics to create (by default, we create binomial and count) for every event
    metricsToCreate.push({
      name: result.displayName,
      type: "binomial",
      alreadyExists: binomialExists,
      shouldCreate: !binomialExists,
      sql: binomialSqlQuery,
      userIdTypes,
    });

    const countSqlQuery = this.getAutoGeneratedMetricSqlQuery(
      result.eventName,
      result.hasUserId,
      schemaFormat,
      "count",
      schema
    );

    const countExists = this.doesMetricExist(
      existingMetrics,
      binomialSqlQuery,
      "binomial"
    );

    metricsToCreate.push({
      name: `Count of ${result.displayName}`,
      type: "count",
      alreadyExists: countExists,
      shouldCreate: !countExists,
      sql: countSqlQuery,
      userIdTypes,
    });

    return metricsToCreate;
  }

  private getTrackedEventSql(
    eventColumn: string,
    displayNameColumn: string,
    userIdColumn: string,
    timestampColumn: string,
    trackedEventTableName: string,
    getDateLimitClause: (dates?: { start: Date; end: Date }) => string,
    schema: string,
    groupByColumn?: string
  ) {
    const end = new Date();
    const start = subDays(new Date(), 7);

    return `
      SELECT
        ${eventColumn} as event,
        MAX(${displayNameColumn}) as display_name,
        (CASE WHEN COUNT(${userIdColumn}) > 0 THEN 1 ELSE 0 END) as has_user_id,
        COUNT (*) as count,
        MAX(${timestampColumn}) as last_tracked_at
      FROM
        ${this.generateTablePath(
          trackedEventTableName,
          schema,
          undefined,
          !!schema
        )}
      WHERE ${getDateLimitClause({ start, end })}
      AND ${eventColumn} NOT IN ('experiment_viewed', 'experiment_started')
      GROUP BY ${groupByColumn || eventColumn}
    `;
  }

  async getAutoMetricsToCreate(
    existingMetrics: MetricInterface[],
    schema: string
  ): Promise<AutoMetricTrackedEvent[]> {
    const schemaFormat = this.datasource.settings.schemaFormat;

    if (
      schemaFormat &&
      this.schemaFormatisAutoFactTablesSchemas(schemaFormat)
    ) {
      const trackedEvents = await this.getEventsTrackedByDatasource(
        schemaFormat,
        schema
      );

      if (!trackedEvents.length) {
        throw new Error(
          "No events found. The query we run to identify tracked events only looks at events from the last 7 days."
        );
      }

      return trackedEvents.map((event) => {
        return {
          ...event,
          metricsToCreate: this.getMetricsToCreate(
            event,
            schemaFormat,
            existingMetrics,
            schema
          ),
        };
      });
    } else {
      throw new Error(
        "Data Source does not support automatic metric generation."
      );
    }
  }

  async getEventsTrackedByDatasource(
    // schemaFormat: SchemaFormat,
    schemaFormat: AutoFactTableSchemas,
    schema?: string
  ): Promise<TrackedEventData[]> {
    const {
      trackedEventTableName,
      userIdColumn,
      eventColumn,
      timestampColumn,
      displayNameColumn,
      getAdditionalEvents,
      getDateLimitClause,
    } = this.getSchemaFormatConfig(schemaFormat);

    const sql = this.getTrackedEventSql(
      eventColumn,
      displayNameColumn || eventColumn,
      userIdColumn,
      timestampColumn,
      trackedEventTableName,
      getDateLimitClause,
      schema || ""
    );

    const { rows: resultRows } = await this.runQuery(
      format(sql, this.getFormatDialect())
    );

    const additionalEvents = getAdditionalEvents();

    for (const additionalEvent of additionalEvents) {
      const sql = this.getTrackedEventSql(
        `'${additionalEvent.eventName}'`,
        `'${additionalEvent.displayName}'`,
        userIdColumn,
        timestampColumn,
        additionalEvent.eventName,
        getDateLimitClause,
        schema || "",
        additionalEvent.groupBy
      );

      try {
        const { rows: additionalEventResults } = await this.runQuery(
          format(sql, this.getFormatDialect())
        );

        additionalEventResults.forEach((result) => {
          if (result.count > 0) {
            resultRows.push(result);
          }
        });
      } catch (e) {
        // This happens when the table doesn't exists - this is optional, so just ignoring
      }
    }

    if (!resultRows) {
      throw new Error(`No events found.`);
    }

    return resultRows.map((result) => {
      const row = result as TrackedEventResponseRow;
      const processedEventData: TrackedEventData = {
        eventName: row.event,
        displayName: row.display_name,
        hasUserId: row.has_user_id,
        count: row.count,
        lastTrackedAt: result.last_tracked_at.value
          ? new Date(result.last_tracked_at.value)
          : new Date(result.last_tracked_at),
      };
      return processedEventData;
    });
  }

  private getMetricQueryFormat(metric: MetricInterface) {
    return metric.queryFormat || (metric.sql ? "sql" : "builder");
  }

  getDateTable(dateArray: string[]): string {
    const dateString = dateArray
      .map((d) => `SELECT ${d} AS day`)
      .join("\nUNION ALL\n");
    return `
      SELECT ${this.dateTrunc(this.castToDate("t.day"))} AS day
      FROM
        (
          ${dateString}
        ) t
     `;
  }

  getQuantileGridColumns(
    metricQuantileSettings: MetricQuantileSettings,
    prefix: string
  ) {
    return `, ${this.quantileColumn(
      `m.${prefix}value`,
      `${prefix}quantile`,
      metricQuantileSettings.quantile
    )}
    ${N_STAR_VALUES.map((nstar) => {
      const { lower, upper } = this.getQuantileBoundValues(
        metricQuantileSettings.quantile,
        0.05,
        nstar
      );
      return `, ${this.quantileColumn(
        `m.${prefix}value`,
        `${prefix}quantile_lower_${nstar}`,
        lower
      )}
          , ${this.quantileColumn(
            `m.${prefix}value`,
            `${prefix}quantile_upper_${nstar}`,
            upper
          )}`;
    }).join("\n")}`;
  }

  public getColumnTopValuesQuery({
    factTable,
    column,
    limit = 50,
  }: ColumnTopValuesParams) {
    if (column.datatype !== "string") {
      throw new Error(`Column ${column.column} is not a string column`);
    }

    const start = new Date();
    start.setDate(start.getDate() - 7);

    return format(
      `
WITH
  __factTable AS (
    ${compileSqlTemplate(factTable.sql, {
      startDate: start,
      templateVariables: {
        eventName: factTable.eventName,
      },
    })}
  ),
  __topValues AS (
    SELECT
      ${column.column} AS value,
      COUNT(*) AS count
    FROM __factTable
    WHERE timestamp >= ${this.toTimestamp(start)}
    GROUP BY ${column.column}
  )
${this.selectStarLimit("__topValues ORDER BY count DESC", limit)}
    `,
      this.getFormatDialect()
    );
  }

  public async runColumnTopValuesQuery(
    sql: string
  ): Promise<ColumnTopValuesResponse> {
    const { rows, statistics } = await this.runQuery(sql);

    return {
      statistics,
      rows: rows.map((r) => ({
        value: r.value + "",
        count: parseFloat(r.count),
      })),
    };
  }

  // Get a Fact Table CTE for multiple fact metrics that all share the same fact table
  private getFactMetricCTE({
    metrics,
    factTableMap,
    baseIdType,
    idJoinMap,
    startDate,
    endDate,
    experimentId,
    addFiltersToWhere,
  }: {
    metrics: FactMetricInterface[];
    factTableMap: FactTableMap;
    baseIdType: string;
    idJoinMap: Record<string, string>;
    startDate: Date;
    endDate: Date | null;
    experimentId?: string;
    addFiltersToWhere?: boolean;
  }) {
    const factTable = factTableMap.get(
      metrics[0]?.numerator?.factTableId || ""
    );
    if (!factTable) {
      throw new Error("Unknown fact table");
    }

    // Determine if a join is required to match up id types
    let join = "";
    let userIdCol = "";
    const userIdTypes = factTable.userIdTypes;
    if (userIdTypes.includes(baseIdType)) {
      userIdCol = baseIdType;
    } else if (userIdTypes.length > 0) {
      for (let i = 0; i < userIdTypes.length; i++) {
        const userIdType: string = userIdTypes[i];
        if (userIdType in idJoinMap) {
          const metricUserIdCol = `m.${userIdType}`;
          join = `JOIN ${idJoinMap[userIdType]} i ON (i.${userIdType} = ${metricUserIdCol})`;
          userIdCol = `i.${baseIdType}`;
          break;
        }
      }
    }

    // BQ datetime cast for SELECT statements (do not use for where)
    const timestampDateTimeColumn = this.castUserDateCol("m.timestamp");

    const sql = factTable.sql;
    const where: string[] = [];

    // Add a rough date filter to improve query performance
    if (startDate) {
      where.push(`m.timestamp >= ${this.toTimestamp(startDate)}`);
    }
    if (endDate) {
      where.push(`m.timestamp <= ${this.toTimestamp(endDate)}`);
    }

    const metricCols: string[] = [];
    // optionally, you can add metric filters to the WHERE clause
    // to filter to rows that match a metric. We AND together each metric
    // filters, before OR together all of the different metrics filters
    const filterWhere: string[] = [];
    metrics.forEach((m, i) => {
      if (m.numerator.factTableId !== factTable.id) {
        throw new Error(
          "Can only combine metrics that are in the same fact table"
        );
      }

      // Numerator column
      const value = this.getMetricColumns(m, factTableMap, "m", false).value;
      const filters = getColumnRefWhereClause(
        factTable,
        m.numerator,
        this.escapeStringLiteral.bind(this),
        this.extractJSONField.bind(this)
      );

      const column =
        filters.length > 0
          ? `CASE WHEN (${filters.join("\n AND ")}) THEN ${value} ELSE NULL END`
          : value;

      metricCols.push(`-- ${m.name}
      ${column} as m${i}_value`);

      if (addFiltersToWhere && filters.length) {
        filterWhere.push(`(${filters.join("\n AND ")})`);
      }

      // Add denominator column if there is one
      if (isRatioMetric(m) && m.denominator) {
        if (m.denominator.factTableId !== factTable.id) {
          throw new Error(
            `Only supports ratio metrics where the denominator is in the same fact table as the numerator: ${m.denominator.factTableId} <> ${factTable.id}`
          );
        }

        const value = this.getMetricColumns(m, factTableMap, "m", true).value;
        const filters = getColumnRefWhereClause(
          factTable,
          m.denominator,
          this.escapeStringLiteral.bind(this),
          this.extractJSONField.bind(this)
        );
        const column =
          filters.length > 0
            ? `CASE WHEN (${filters.join(" AND ")}) THEN ${value} ELSE NULL END`
            : value;
        metricCols.push(`-- ${m.name} (denominator)
        ${column} as m${i}_denominator`);

        if (addFiltersToWhere && filters.length) {
          filterWhere.push(`(${filters.join(" AND ")})`);
        }
      }
    });

    if (filterWhere.length) {
      where.push("(" + filterWhere.join(" OR ") + ")");
    }

    return compileSqlTemplate(
      `-- Fact Table (${factTable.name})
      SELECT
        ${userIdCol} as ${baseIdType},
        ${timestampDateTimeColumn} as timestamp,
        ${metricCols.join(",\n")}
      FROM(
          ${sql}
        ) m
        ${join}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `,
      {
        startDate,
        endDate: endDate || undefined,
        experimentId,
        templateVariables: getMetricTemplateVariables(
          metrics[0],
          factTableMap,
          false
        ),
      }
    );
  }

  // Get a Fact Table CTE for segments based on fact tables
  private getFactSegmentCTE({
    factTable,
    baseIdType,
    idJoinMap,
    filters,
    sqlVars,
  }: {
    factTable: FactTableInterface;
    baseIdType: string;
    idJoinMap: Record<string, string>;
    filters?: string[];
    sqlVars?: SQLVars;
  }) {
    // Determine if a join is required to match up id types
    let join = "";
    let userIdCol = "";
    const userIdTypes = factTable.userIdTypes;
    if (userIdTypes.includes(baseIdType)) {
      userIdCol = baseIdType;
    } else if (userIdTypes.length > 0) {
      for (let i = 0; i < userIdTypes.length; i++) {
        const userIdType: string = userIdTypes[i];
        if (userIdType in idJoinMap) {
          const metricUserIdCol = `m.${userIdType}`;
          join = `JOIN ${idJoinMap[userIdType]} i ON (i.${userIdType} = ${metricUserIdCol})`;
          userIdCol = `i.${baseIdType}`;
          break;
        }
      }
    }

    // BQ datetime cast for SELECT statements (do not use for where)
    const timestampDateTimeColumn = this.castUserDateCol("m.timestamp");

    const sql = factTable.sql;

    const where: string[] = [];

    if (filters?.length) {
      filters.forEach((filter) => {
        const filterObj = factTable.filters.find(
          (factFilter) => factFilter.id === filter
        );

        if (filterObj) {
          where.push(filterObj.value);
        }
      });
    }

    const baseSql = `-- Fact Table (${factTable.name})
    SELECT
      ${userIdCol} as ${baseIdType},
      ${timestampDateTimeColumn} as date
    FROM(
        ${sql}
      ) m
      ${join}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `;
    return sqlVars ? compileSqlTemplate(baseSql, sqlVars) : baseSql;
  }

  private getMetricCTE({
    metric,
    baseIdType,
    idJoinMap,
    startDate,
    endDate,
    experimentId,
    factTableMap,
    useDenominator,
  }: {
    metric: ExperimentMetricInterface;
    baseIdType: string;
    idJoinMap: Record<string, string>;
    startDate: Date;
    endDate: Date | null;
    experimentId?: string;
    factTableMap: FactTableMap;
    useDenominator?: boolean;
  }) {
    const cols = this.getMetricColumns(
      metric,
      factTableMap,
      "m",
      useDenominator
    );

    // Determine the identifier column to select from
    let userIdCol = cols.userIds[baseIdType] || "user_id";
    let join = "";

    const userIdTypes = getUserIdTypes(metric, factTableMap, useDenominator);

    const isFact = isFactMetric(metric);
    const queryFormat = isFact ? "fact" : this.getMetricQueryFormat(metric);
    const columnRef = isFact
      ? useDenominator
        ? metric.denominator
        : metric.numerator
      : null;

    // For fact metrics with a WHERE clause
    const factTable = isFact
      ? factTableMap.get(columnRef?.factTableId || "")
      : undefined;

    if (isFact && !factTable) {
      throw new Error("Could not find fact table");
    }

    // query builder does not use a sub-query to get a the userId column to
    // equal the userIdType, so when using the query builder, continue to
    // use the actual input column name rather than the id type
    if (userIdTypes.includes(baseIdType)) {
      userIdCol = queryFormat === "builder" ? userIdCol : baseIdType;
    } else if (userIdTypes.length > 0) {
      for (let i = 0; i < userIdTypes.length; i++) {
        const userIdType: string = userIdTypes[i];
        if (userIdType in idJoinMap) {
          const metricUserIdCol =
            queryFormat === "builder"
              ? cols.userIds[userIdType]
              : `m.${userIdType}`;
          join = `JOIN ${idJoinMap[userIdType]} i ON (i.${userIdType} = ${metricUserIdCol})`;
          userIdCol = `i.${baseIdType}`;
          break;
        }
      }
    }

    // BQ datetime cast for SELECT statements (do not use for where)
    const timestampDateTimeColumn = this.castUserDateCol(cols.timestamp);

    const schema = this.getSchema();

    const where: string[] = [];
    let sql = "";

    // From old, deprecated query builder UI
    if (queryFormat === "builder" && !isFact && metric.conditions?.length) {
      metric.conditions.forEach((c) => {
        where.push(`m.${c.column} ${c.operator} '${c.value}'`);
      });
    }

    // Add filters from the Metric
    if (isFact && factTable && columnRef) {
      getColumnRefWhereClause(
        factTable,
        columnRef,
        this.escapeStringLiteral.bind(this),
        this.extractJSONField.bind(this)
      ).forEach((filterSQL) => {
        where.push(filterSQL);
      });

      sql = factTable.sql;
    }

    if (!isFact && queryFormat === "sql") {
      sql = metric.sql || "";
    }

    // Add date filter
    if (startDate) {
      where.push(`${cols.timestamp} >= ${this.toTimestamp(startDate)}`);
    }
    if (endDate) {
      where.push(`${cols.timestamp} <= ${this.toTimestamp(endDate)}`);
    }

    return compileSqlTemplate(
      `-- Metric (${metric.name})
      SELECT
        ${userIdCol} as ${baseIdType},
        ${cols.value} as value,
        ${timestampDateTimeColumn} as timestamp
      FROM
        ${
          queryFormat === "sql" || queryFormat === "fact"
            ? `(
              ${sql}
            )`
            : !isFact
            ? (schema && !metric.table?.match(/\./) ? schema + "." : "") +
              (metric.table || "")
            : ""
        } m
        ${join}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `,
      {
        startDate,
        endDate: endDate || undefined,
        experimentId,
        templateVariables: getMetricTemplateVariables(
          metric,
          factTableMap,
          useDenominator
        ),
      }
    );
  }

  // Only include users who entered the experiment before this timestamp
  private getExperimentEndDate(
    settings: ExperimentSnapshotSettings,
    conversionWindowHours: number
  ): Date {
    // If we need to wait until users have had a chance to fully convert
    if (settings.skipPartialData) {
      // The last date allowed to give enough time for users to convert
      const conversionWindowEndDate = new Date();
      conversionWindowEndDate.setHours(
        conversionWindowEndDate.getHours() - conversionWindowHours
      );

      // Use the earliest of either the conversion end date or the phase end date
      return new Date(
        Math.min(settings.endDate.getTime(), conversionWindowEndDate.getTime())
      );
    }

    // Otherwise, use the actual end date
    return settings.endDate;
  }

  private getSegmentCTE(
    segment: SegmentInterface,
    baseIdType: string,
    idJoinMap: Record<string, string>,
    factTableMap: FactTableMap,
    sqlVars?: SQLVars
  ) {
    // replace template variables
    let segmentSql = "";

    if (segment.type === "SQL") {
      if (!segment.sql) {
        throw new Error(
          `Segment ${segment.name} is a SQL Segment but has no SQL value`
        );
      }
      segmentSql = sqlVars
        ? compileSqlTemplate(segment.sql, sqlVars)
        : segment.sql;
    } else {
      if (!segment.factTableId) {
        throw new Error(
          `Segment ${segment.name} is a FACT Segment, but has no factTableId set`
        );
      }
      const factTable = factTableMap.get(segment.factTableId);

      if (!factTable) {
        throw new Error(`Unknown fact table: ${segment.factTableId}`);
      }

      segmentSql = this.getFactSegmentCTE({
        baseIdType,
        idJoinMap,
        factTable,
        filters: segment.filters,
        sqlVars,
      });

      return `-- Segment (${segment.name})
        SELECT * FROM (\n${segmentSql}\n) s `;
    }

    const dateCol = this.castUserDateCol("s.date");

    const userIdType = segment.userIdType || "user_id";

    // Need to use an identity join table
    if (userIdType !== baseIdType) {
      return `-- Segment (${segment.name})
      SELECT
        i.${baseIdType},
        ${dateCol} as date
      FROM
        (
          ${segmentSql}
        ) s
        JOIN ${idJoinMap[userIdType]} i ON ( i.${userIdType} = s.${userIdType} )
      `;
    }

    if (dateCol !== "s.date") {
      return `-- Segment (${segment.name})
      SELECT
        s.${userIdType},
        ${dateCol} as date
      FROM
        (
          ${segmentSql}
        ) s`;
    }
    return `-- Segment (${segment.name})
    ${segmentSql}
    `;
  }

  private getDimensionCTE(
    dimension: DimensionInterface,
    baseIdType: string,
    idJoinMap: Record<string, string>
  ) {
    const userIdType = dimension.userIdType || "user_id";

    // Need to use an identity join table
    if (userIdType !== baseIdType) {
      return `-- Dimension (${dimension.name})
      SELECT
        i.${baseIdType},
        d.value
      FROM
        (
          ${dimension.sql}
        ) d
        JOIN ${idJoinMap[userIdType]} i ON ( i.${userIdType} = d.${userIdType} )
      `;
    }

    return `-- Dimension (${dimension.name})
    ${dimension.sql}
    `;
  }

  private addCaseWhenTimeFilter(
    col: string,
    metric: ExperimentMetricInterface,
    overrideConversionWindows: boolean,
    endDate: Date,
    cumulativeDate: boolean,
    metricQuantileSettings?: MetricQuantileSettings
  ): string {
    return `${this.ifElse(
      `${this.getConversionWindowClause(
        "d.timestamp",
        "m.timestamp",
        metric,
        endDate,
        cumulativeDate,
        overrideConversionWindows
      )}
        ${metricQuantileSettings?.ignoreZeros ? `AND ${col} != 0` : ""}
        ${
          cumulativeDate ? `AND ${this.dateTrunc("m.timestamp")} <= dr.day` : ""
        }
      `,
      `${col}`,
      `NULL`
    )}`;
  }

  private getAggregateMetricColumn({
    metric,
    useDenominator,
    valueColumn = "value",
    quantileColumn = "qm.quantile",
    willReaggregate,
  }: {
    metric: ExperimentMetricInterface;
    useDenominator?: boolean;
    valueColumn?: string;
    quantileColumn?: string;
    willReaggregate?: boolean;
  }) {
    // Fact Metrics
    if (isFactMetric(metric)) {
      const columnRef = useDenominator ? metric.denominator : metric.numerator;

      const hasAggregateFilter =
        getAggregateFilters({
          columnRef: columnRef,
          column: columnRef?.column || "",
          ignoreInvalid: true,
        }).length > 0;

      const column = hasAggregateFilter
        ? columnRef?.aggregateFilterColumn
        : columnRef?.column;

      if (
        !hasAggregateFilter &&
        (isBinomialMetric(metric) || column === "$$distinctUsers")
      ) {
        return `COALESCE(MAX(${valueColumn}), 0)`;
      } else if (column === "$$count") {
        return `COUNT(${valueColumn})`;
      } else if (
        metric.metricType === "quantile" &&
        metric.quantileSettings?.type === "event"
      ) {
        return `SUM(${this.ifElse(
          `${valueColumn} <= ${quantileColumn}`,
          "1",
          "0"
        )})`;
      } else if (
        metric.metricType === "quantile" &&
        metric.quantileSettings?.type === "unit" &&
        metric.quantileSettings?.ignoreZeros
      ) {
        return `SUM(${valueColumn})`;
      } else if (
        !columnRef?.column.startsWith("$$") &&
        columnRef?.aggregation === "count distinct"
      ) {
        if (willReaggregate) {
          return this.hllAggregate(valueColumn);
        }
        return this.hllCardinality(this.hllAggregate(valueColumn));
      } else if (
        !columnRef?.column.startsWith("$$") &&
        columnRef?.aggregation === "max"
      ) {
        return `COALESCE(MAX(${valueColumn}), 0)`;
      } else {
        return `SUM(COALESCE(${valueColumn}, 0))`;
      }
    }

    // Non-fact Metrics

    // Binomial metrics don't have a value, so use hard-coded "1" as the value
    if (metric.type === "binomial") {
      return `MAX(COALESCE(value, 0))`;
    }

    // SQL editor
    if (this.getMetricQueryFormat(metric) === "sql") {
      // Custom aggregation that's a hardcoded number (e.g. "1")
      if (metric.aggregation && Number(metric.aggregation)) {
        // Note that if user has conversion row but value IS NULL, this will
        // return 0 for that user rather than `metric.aggregation`
        return this.ifElse("value IS NOT NULL", metric.aggregation, "0");
      }
      // Other custom aggregation
      else if (metric.aggregation) {
        return replaceCountStar(metric.aggregation, `value`);
      }
      // Standard aggregation (SUM)
      else {
        return `SUM(COALESCE(value, 0))`;
      }
    }
    // Query builder
    else {
      // Count metrics that specify a distinct column to count
      if (metric.type === "count" && metric.column) {
        return `COUNT(DISTINCT (value))`;
      }
      // Count metrics just do a simple count of rows by default
      else if (metric.type === "count") {
        return `COUNT(value)`;
      }
      // Revenue and duration metrics use MAX by default
      else {
        return `MAX(COALESCE(value, 0))`;
      }
    }
  }

  private getReaggregateMetricColumn(
    metric: ExperimentMetricInterface,
    useDenominator?: boolean,
    valueColumn: string = "value"
  ) {
    if (quantileMetricType(metric)) {
      throw new Error("Quantile metrics are not supported for reaggregation");
    }
    // Fact Metrics
    if (isFactMetric(metric)) {
      const columnRef = useDenominator ? metric.denominator : metric.numerator;

      const hasAggregateFilter =
        getAggregateFilters({
          columnRef: columnRef,
          column: columnRef?.column || "",
          ignoreInvalid: true,
        }).length > 0;

      const column = hasAggregateFilter
        ? columnRef?.aggregateFilterColumn
        : columnRef?.column;

      if (
        !hasAggregateFilter &&
        (isBinomialMetric(metric) || column === "$$distinctUsers")
      ) {
        return `MAX(COALESCE(${valueColumn}, 0))`;
      } else if (
        !columnRef?.column.startsWith("$$") &&
        columnRef?.aggregation === "count distinct"
      ) {
        return this.hllCardinality(this.hllReaggregate(valueColumn));
      } else if (
        !columnRef?.column.startsWith("$$") &&
        columnRef?.aggregation === "max"
      ) {
        return `MAX(COALESCE(${valueColumn}, 0))`;
      } else {
        return `SUM(COALESCE(${valueColumn}, 0))`;
      }
    }

    // Non-fact Metrics
    throw new Error("Non-fact metrics are not supported for reaggregation");
  }

  private getValueFromAggregateColumns(
    col: string,
    columnRef?: ColumnRef | null
  ): string {
    if (
      !columnRef?.column.startsWith("$$") &&
      columnRef?.aggregation === "count distinct"
    ) {
      return this.hllCardinality(col);
    }

    return col;
  }

  private getMetricColumns(
    metric: ExperimentMetricInterface,
    factTableMap: FactTableMap,
    alias = "m",
    useDenominator?: boolean
  ): { userIds: Record<string, string>; timestamp: string; value: string } {
    if (isFactMetric(metric)) {
      const userIds: Record<string, string> = {};
      getUserIdTypes(metric, factTableMap, useDenominator).forEach(
        (userIdType) => {
          userIds[userIdType] = `${alias}.${userIdType}`;
        }
      );

      const columnRef = useDenominator ? metric.denominator : metric.numerator;

      const factTable = factTableMap.get(columnRef?.factTableId || "");

      const hasAggregateFilter =
        getAggregateFilters({
          columnRef: columnRef,
          column: columnRef?.column || "",
          ignoreInvalid: true,
        }).length > 0;

      const column = hasAggregateFilter
        ? columnRef?.aggregateFilterColumn
        : columnRef?.column;

      const value =
        (!hasAggregateFilter && isBinomialMetric(metric)) ||
        !columnRef ||
        column === "$$distinctUsers" ||
        column === "$$count"
          ? "1"
          : factTable && column
          ? getColumnExpression(
              column,
              factTable,
              this.extractJSONField.bind(this),
              alias
            )
          : `${alias}.${column}`;

      return {
        userIds,
        timestamp: `${alias}.timestamp`,
        value,
      };
    }

    const queryFormat = this.getMetricQueryFormat(metric);

    // Directly inputting SQL (preferred)
    if (queryFormat === "sql") {
      const userIds: Record<string, string> = {};
      metric.userIdTypes?.forEach((userIdType) => {
        userIds[userIdType] = `${alias}.${userIdType}`;
      });
      return {
        userIds: userIds,
        timestamp: `${alias}.timestamp`,
        value: metric.type === "binomial" ? "1" : `${alias}.value`,
      };
    }

    // Using the query builder (legacy)
    let valueCol = metric.column || "value";
    if (metric.type === "duration" && valueCol.match(/\{alias\}/)) {
      valueCol = valueCol.replace(/\{alias\}/g, alias);
    } else {
      valueCol = alias + "." + valueCol;
    }
    const value = metric.type !== "binomial" && metric.column ? valueCol : "1";

    const userIds: Record<string, string> = {};
    metric.userIdTypes?.forEach((userIdType) => {
      userIds[userIdType] = `${alias}.${
        metric.userIdColumns?.[userIdType] || userIdType
      }`;
    });

    return {
      userIds,
      timestamp: `${alias}.${metric.timestampColumn || "received_at"}`,
      value,
    };
  }

  private getIdentitiesQuery(
    settings: DataSourceSettings,
    id1: string,
    id2: string,
    from: Date,
    to: Date | undefined,
    experimentId?: string
  ) {
    if (settings?.queries?.identityJoins) {
      for (let i = 0; i < settings.queries.identityJoins.length; i++) {
        const join = settings?.queries?.identityJoins[i];
        if (
          join.query.length > 6 &&
          join.ids.includes(id1) &&
          join.ids.includes(id2)
        ) {
          return `
          SELECT
            ${id1},
            ${id2}
          FROM
            (
              ${compileSqlTemplate(join.query, {
                startDate: from,
                endDate: to,
                experimentId,
              })}
            ) i
          GROUP BY
            ${id1}, ${id2}
          `;
        }
      }
    }
    if (settings?.queries?.pageviewsQuery) {
      const timestampColumn = "i.timestamp";

      if (
        ["user_id", "anonymous_id"].includes(id1) &&
        ["user_id", "anonymous_id"].includes(id2)
      ) {
        return `
        SELECT
          user_id,
          anonymous_id
        FROM
          (${compileSqlTemplate(settings.queries.pageviewsQuery, {
            startDate: from,
            endDate: to,
            experimentId,
          })}) i
        WHERE
          ${timestampColumn} >= ${this.toTimestamp(from)}
          ${to ? `AND ${timestampColumn} <= ${this.toTimestamp(to)}` : ""}
        GROUP BY
          user_id, anonymous_id
        `;
      }
    }

    throw new Error(`Missing identifier join table for '${id1}' and '${id2}'.`);
  }
}
