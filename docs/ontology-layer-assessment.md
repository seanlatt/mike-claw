# Ontology Layer Assessment: BFO/CCO for Mike and mike-claw

**Date**: November 22, 2026  
**Author**: Automated analysis  
**Status**: Assessment only (no implementation)

---

## Context

Sean maintains three related repositories:
- `seanlatt/mike` - fork of open-legal-products/mike
- `seanlatt/mike-claw` - OpenClaw-native fork with gateway integration
- `seanlatt/CommonCoreOntologies` - fork of CommonCoreOntologies/CommonCoreOntologies

This assessment evaluates whether a CCO-based ontology layer (built on BFO) would add value to Mike or mike-claw.

---

## What is BFO/CCO?

**Basic Formal Ontology (BFO)** is a top-level ontology providing domain-neutral categories: objects, processes, qualities, dispositions. It answers questions like "what kinds of things exist?" at the most abstract level.

**Common Core Ontologies (CCO)** extends BFO with mid-level concepts useful across domains: agents, artifacts, information entities, events, geospatial entities. CCO sits between pure BFO and domain-specific ontologies.

Together they provide a principled framework for representing knowledge that can:
- Enable interoperability between systems
- Support complex reasoning
- Provide formal semantics for data

---

## Current State of Mike/mike-claw

### Data Model

Mike's current data model is relational/document-oriented:

```
projects (matters)
  └── documents
        └── document_versions
  └── folders
  └── chat_sessions
        └── messages
  └── workflows
  └── tabular_reviews
```

### Knowledge Representation

The "wiki" layer in mike-claw adds markdown-based knowledge capture:

```
.wiki/
  matter-<id>/
    parties.md
    timeline.md
    obligations.md
    risks.md
    definitions.md
```

This is unstructured text, not formal ontology. The LLM populates and reads it via tools.

### Schema Design

Mike uses PostgreSQL with JSONB for flexible fields but no ontological backbone. Entities are defined pragmatically:

- A "document" is a file with metadata
- A "project" is a container for documents
- A "workflow" is a sequence of steps

---

## Potential Benefits of CCO/BFO

### 1. Formal Entity Classification

CCO provides categories that map to legal practice:

| CCO Class | Mike/Legal Application |
|-----------|----------------------|
| `Agent` | Parties (individuals, organizations) |
| `Artifact` | Contracts, pleadings, exhibits |
| `InformationBearingEntity` | Documents, clauses, provisions |
| `ProcessualEntity` | Transactions, proceedings, workflows |
| `TemporalRegion` | Deadlines, effective dates, terms |
| `SpatialRegion` | Jurisdictions, venues |

### 2. Relationship Typing

CCO/BFO distinguishes:
- **Parthood**: a clause is part of a contract
- **Participation**: a party participates in a transaction
- **Realization**: a contract realizes an agreement
- **Disposition**: a clause has a termination disposition

This could enable queries like "find all obligations that party X participates in."

### 3. Interoperability

A CCO-aligned data model could exchange data with:
- Other legal tech systems using CCO
- Research databases
- Government systems (some use BFO-based ontologies)

### 4. Reasoning Support

With formal semantics, a reasoner could:
- Infer implicit relationships
- Check consistency
- Derive classifications

---

## Challenges and Costs

### 1. Integration Complexity

Retrofitting CCO onto Mike's relational schema requires:
- Mapping existing tables to ontology classes
- Adding new relationship tables or graph layer
- Updating all queries to use the new model

This is a substantial architectural change.

### 2. Performance Overhead

Ontological reasoning adds latency:
- OWL reasoners are computationally expensive
- Graph queries can be slower than SQL for simple lookups
- Materialization vs. runtime reasoning tradeoffs

For a real-time legal assistant, this could be prohibitive.

### 3. Maintenance Burden

CCO is maintained by a community with its own release cycle. Using it means:
- Tracking CCO updates
- Resolving conflicts when CCO changes
- Training developers on ontology concepts

### 4. Limited LLM Integration

Modern LLMs do not natively understand OWL ontologies. The benefits of formal semantics are mostly realized by:
- Traditional reasoners (Pellet, HermiT)
- SPARQL endpoints
- Rule-based systems

An LLM would need explicit prompting to follow ontological distinctions, negating much of the benefit.

### 5. Overkill for Current Use Cases

Mike's current capabilities (document review, chat, workflows) do not obviously require formal ontology. The wiki layer's markdown files achieve practical knowledge capture without the overhead.

---

## Alternative Approaches

### 1. Schema-Level Conventions

Add CCO-inspired naming and structure without full ontology:

```typescript
interface Party {
  id: string;
  type: "individual" | "organization";  // CCO Agent subclasses
  name: string;
}

interface Obligation {
  id: string;
  bearerPartyId: string;    // who must perform
  recipientPartyId: string; // who benefits
  content: string;
  deadlineType: "fixed" | "relative" | "recurring";
}
```

This borrows concepts without the machinery.

### 2. Lightweight Taxonomies

Define controlled vocabularies for:
- Document types
- Party roles
- Obligation categories
- Risk classifications

Stored as enum tables or JSON schemas rather than OWL.

### 3. Graph Database for Relationships

Add a Neo4j or similar layer for relationship queries while keeping relational core:

```cypher
(party:Party)-[:OBLIGATED_TO]->(obligation:Obligation)-[:BENEFITS]->(party2:Party)
```

This enables graph traversal without full ontology.

### 4. LLM-Native Knowledge Graphs

Use the LLM itself to maintain and query a knowledge graph in natural language. The wiki layer already does something like this.

---

## Assessment

### Does CCO/BFO Add Value Today?

**Short answer: Not enough to justify the investment.**

| Factor | Assessment |
|--------|------------|
| Technical benefit | Moderate (better structure) |
| Implementation cost | High (architectural overhaul) |
| Performance impact | Negative (reasoning overhead) |
| LLM compatibility | Poor (LLMs don't use OWL) |
| Maintenance burden | High (tracking CCO releases) |
| Interop benefits | Speculative (few CCO-aligned legal systems exist) |

### When Would It Make Sense?

CCO integration would be worth considering if:
1. Mike needed to exchange structured data with CCO-aligned systems
2. Complex automated reasoning was required (not just LLM inference)
3. A dedicated team could maintain the ontology layer
4. Performance was not a concern (batch processing, not real-time)

None of these conditions apply to mike-claw's current direction.

---

## Recommendation

**Do not implement a CCO/BFO ontology layer.** Instead:

1. **Keep the wiki layer** as the primary knowledge store. It is flexible, LLM-friendly, and adequate for current needs.

2. **Adopt CCO-inspired naming** where convenient. Use terms like "Agent," "Artifact," "Obligation" in code and schemas without formal ontology machinery.

3. **Consider a lightweight taxonomy** for document types, party roles, and obligation categories. This provides structure without overhead.

4. **Revisit if interop needs emerge.** If a future integration requires CCO alignment, evaluate a mapping layer rather than full adoption.

5. **Archive or fork CommonCoreOntologies** for reference but do not integrate it into Mike's runtime.

---

## Summary

The CCO/BFO ontology framework is academically rigorous and potentially useful for certain knowledge engineering tasks. However, for Mike and mike-claw as LLM-powered legal assistants, the costs outweigh the benefits. The existing wiki-based knowledge layer, combined with LLM inference, provides sufficient structure for current and foreseeable use cases.

**Bottom line**: CCO is a good idea in theory but the wrong tool for this job. Keep the wiki layer, borrow useful concepts from CCO's vocabulary, and skip the formal ontology machinery.
