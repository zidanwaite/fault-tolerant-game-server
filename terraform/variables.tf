variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "app_name" {
  description = "Application name — used as a prefix for all resource names"
  type        = string
  default     = "my-app"
}

variable "app_port" {
  description = "Port the Node.js server listens on"
  type        = number
  default     = 3001
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "ecs_cpu" {
  description = "ECS task CPU units (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "ecs_memory" {
  description = "ECS task memory in MB"
  type        = number
  default     = 512
}

variable "ecs_desired_count" {
  description = "Number of ECS task instances to run"
  type        = number
  default     = 1
}

variable "jwt_secret" {
  description = "JWT signing secret for auth tokens"
  type        = string
  sensitive   = true
}

variable "admin_token" {
  description = "Admin API token"
  type        = string
  sensitive   = true
}
